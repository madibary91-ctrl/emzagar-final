"use server";

import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { rateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/modules/audit/service";
import { MAX_INSTRUCTIONS, isKind } from "./constants";
import { addDoc, clearStyleProfile, deleteDoc, getDocPreview, importFromSystem, savePersonalization, setDocEnabled, setDocKind } from "./service";
import { learnStyleProfile } from "./profile";

export type KState = { ok?: boolean; error?: string; message?: string };

const PAGE = "/admin/knowledge";
const kindsText = (k: Record<string, number>) => Object.entries(k).map(([a, n]) => `${n} ${a}`).join("، ");

/** افزودن سند از متن چسبانده‌شده */
export async function addPasteAction(_prev: KState, fd: FormData): Promise<KState> {
  const team = await requireTeam("write");
  if (!rateLimit(`kb:${team.id}`, 20, 60_000).ok) return { error: "درخواست‌ها زیاد بود؛ کمی صبر کنید." };
  const r = await addDoc({
    workspaceId: team.workspaceId,
    userId: team.id,
    title: String(fd.get("title") || "").trim() || "متن چسبانده‌شده",
    kind: String(fd.get("kind") || "sample"),
    source: "paste",
    rawText: String(fd.get("text") || "").slice(0, 400_000),
    redact: fd.get("redact") === "on",
  });
  if (!r.ok) return { error: r.error };
  await logAudit({ action: "ai.knowledge.added", workspaceId: team.workspaceId, userId: team.id, detail: `متن: ${String(fd.get("title") || "").slice(0, 60)}` });
  revalidatePath(PAGE);
  return { ok: true, message: r.redactions ? `افزوده شد؛ ${r.redactions} مورد اطلاعات حساس (${kindsText(r.kinds)}) به‌طور خودکار حذف شد.` : "سند به حافظه افزوده شد." };
}

export async function toggleDocAction(id: number, enabled: boolean): Promise<KState> {
  const team = await requireTeam("write");
  if (!Number.isInteger(id)) return { error: "شناسه نامعتبر است" };
  const ok = await setDocEnabled(team.workspaceId, id, !!enabled);
  revalidatePath(PAGE);
  return ok ? { ok: true } : { error: "سند یافت نشد" };
}

export async function setKindAction(id: number, kind: string): Promise<KState> {
  const team = await requireTeam("write");
  if (!Number.isInteger(id) || !isKind(kind)) return { error: "ورودی نامعتبر است" };
  const ok = await setDocKind(team.workspaceId, id, kind);
  revalidatePath(PAGE);
  return ok ? { ok: true } : { error: "سند یافت نشد" };
}

export async function deleteDocAction(id: number): Promise<KState> {
  const team = await requireTeam("write");
  if (!Number.isInteger(id)) return { error: "شناسه نامعتبر است" };
  const ok = await deleteDoc(team.workspaceId, id);
  if (ok) await logAudit({ action: "ai.knowledge.deleted", workspaceId: team.workspaceId, userId: team.id, detail: `سند #${id}` });
  revalidatePath(PAGE);
  return ok ? { ok: true } : { error: "سند یافت نشد" };
}

/** پیش‌نمایش متن ذخیره‌شده (پس از حذف اطلاعات حساس) — فقط سند همین فضای کاری */
export async function previewDocAction(id: number): Promise<{ title?: string; text?: string; total?: number; error?: string }> {
  const team = await requireTeam("view");
  if (!Number.isInteger(id)) return { error: "شناسه نامعتبر است" };
  const d = await getDocPreview(team.workspaceId, id);
  return d ?? { error: "سند یافت نشد" };
}

export async function saveSettingsAction(_prev: KState, fd: FormData): Promise<KState> {
  const team = await requireTeam("write");
  await savePersonalization(team.workspaceId, { enabled: fd.get("enabled") === "on", instructions: String(fd.get("instructions") || "").slice(0, MAX_INSTRUCTIONS * 2) });
  await logAudit({ action: "ai.knowledge.settings", workspaceId: team.workspaceId, userId: team.id, detail: fd.get("enabled") === "on" ? "شخصی‌سازی روشن" : "شخصی‌سازی خاموش" });
  revalidatePath(PAGE);
  return { ok: true, message: "تنظیمات ذخیره شد." };
}

export async function importAction(_prev: KState, fd: FormData): Promise<KState> {
  const team = await requireTeam("write");
  if (!rateLimit(`kb-import:${team.id}`, 10, 60_000).ok) return { error: "درخواست‌ها زیاد بود؛ کمی صبر کنید." };
  const type = fd.get("type") === "template" ? "template" : "contract";
  const ids = fd.getAll("ids").map((v) => Number(v));
  const r = await importFromSystem({ workspaceId: team.workspaceId, userId: team.id, type, ids });
  revalidatePath(PAGE);
  if (r.added === 0) return { error: r.errors[0] || "موردی افزوده نشد" };
  await logAudit({ action: "ai.knowledge.imported", workspaceId: team.workspaceId, userId: team.id, detail: `${r.added} ${type === "contract" ? "قرارداد" : "قالب"}` });
  return { ok: true, message: `${r.added} مورد افزوده شد${r.skipped ? ` (${r.skipped} مورد رد شد: ${r.errors.slice(0, 2).join(" ؛ ")})` : ""}.` };
}

/** «یادگیری سبک»: یک تماس AI که شناسنامه‌ی نگارش را استخراج می‌کند */
export async function learnProfileAction(): Promise<KState> {
  const team = await requireTeam("write");
  if (!rateLimit(`kb-learn:${team.id}`, 3, 60_000).ok) return { error: "چند بار پشت‌سرهم زدید؛ یک دقیقه صبر کنید." };
  const r = await learnStyleProfile({ workspaceId: team.workspaceId, workspaceName: team.workspaceName, userId: team.id });
  if (!r.ok) return { error: r.error };
  await logAudit({ action: "ai.knowledge.learned", workspaceId: team.workspaceId, userId: team.id, detail: `${r.docs} سند` });
  revalidatePath(PAGE);
  return { ok: true, message: `شناسنامه‌ی نگارش از ${r.docs} سند ساخته شد. سهمیه‌ی باقی‌مانده: ${r.remaining}` };
}

export async function clearProfileAction(): Promise<KState> {
  const team = await requireTeam("write");
  await clearStyleProfile(team.workspaceId);
  revalidatePath(PAGE);
  return { ok: true, message: "شناسنامه‌ی نگارش پاک شد." };
}

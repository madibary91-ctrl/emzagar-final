"use server";

import { revalidatePath } from "next/cache";
import { rateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/modules/audit/service";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { saveGlobalSetting } from "@/modules/settings/service";
import { defaultDoc, sanitizeDoc, type LandingDoc } from "./schema";
import { getLandingVersion, listLandingVersions, publishLanding, saveDraftLanding } from "./service";

export type SaveResult = { ok: boolean; error?: string; doc?: LandingDoc; at?: string };
export type VersionRow = { id: number; note: string; at: string };

const MAX_BYTES = 400_000;

function tooBig(input: unknown): boolean {
  try {
    return JSON.stringify(input).length > MAX_BYTES;
  } catch {
    return true;
  }
}

async function syncPlatformName(doc: LandingDoc) {
  const name = String(doc.theme.brandName || "").trim();
  if (name) await saveGlobalSetting("platform_name", name);
}

/** ذخیره‌ی خودکار پیش‌نویس (بازدیدکنندگان همچنان نسخه‌ی منتشرشده را می‌بینند) */
export async function saveDraftAction(input: unknown): Promise<SaveResult> {
  const admin = await requirePlatformAdmin();
  if (tooBig(input)) return { ok: false, error: "حجم محتوا بیش از حد مجاز است." };
  if (!rateLimit(`landing:draft:${admin.id}`, 120, 60_000).ok) return { ok: false, error: "ذخیره‌ی بیش از حد؛ چند لحظه صبر کنید." };
  const doc = await saveDraftLanding(input);
  return { ok: true, doc, at: new Date().toISOString() };
}

export async function publishAction(input: unknown, note: string): Promise<SaveResult> {
  const admin = await requirePlatformAdmin();
  if (tooBig(input)) return { ok: false, error: "حجم محتوا بیش از حد مجاز است." };
  if (!rateLimit(`landing:publish:${admin.id}`, 20, 60_000).ok) return { ok: false, error: "انتشار بیش از حد؛ چند لحظه صبر کنید." };
  const doc = await publishLanding(input, admin.id, String(note || "").trim() || "انتشار");
  await syncPlatformName(doc);
  await logAudit({ action: "landing.published", userId: admin.id, detail: note.slice(0, 80) });
  revalidatePath("/");
  return { ok: true, doc, at: new Date().toISOString() };
}

export async function listVersionsAction(): Promise<VersionRow[]> {
  await requirePlatformAdmin();
  const rows = await listLandingVersions();
  return rows.map((r) => ({ id: r.id, note: r.note, at: r.createdAt.toISOString() }));
}

/** بازگردانی یک نسخه‌ی قدیمی به‌عنوان پیش‌نویس (تا زمان انتشار روی سایت اثری ندارد) */
export async function restoreVersionAction(id: number): Promise<SaveResult> {
  await requirePlatformAdmin();
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "نسخه نامعتبر است." };
  const doc = await getLandingVersion(id);
  if (!doc) return { ok: false, error: "این نسخه پیدا نشد." };
  const saved = await saveDraftLanding(doc);
  return { ok: true, doc: saved };
}

export async function resetToDefaultAction(brandName: string): Promise<SaveResult> {
  await requirePlatformAdmin();
  const doc = await saveDraftLanding(defaultDoc(String(brandName || "").slice(0, 40) || undefined));
  return { ok: true, doc: sanitizeDoc(doc) };
}

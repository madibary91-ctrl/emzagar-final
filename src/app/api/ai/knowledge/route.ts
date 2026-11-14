import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getTeamForApi } from "@/modules/tenancy/context";
import { addDoc } from "@/modules/ai/knowledge/service";
import { isKind } from "@/modules/ai/knowledge/constants";
import { MAX_FILE_BYTES, extractText } from "@/modules/ai/knowledge/text";
import { logAudit } from "@/modules/audit/service";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const MAX_FILES = 5;

/** آپلود فایل‌های دانش (TXT/MD/HTML/DOCX). فایل اصلی ذخیره نمی‌شود؛ فقط متن پاک‌سازی‌شده */
export async function POST(req: Request) {
  const team = await getTeamForApi("write");
  if (!team) return json({ ok: false, error: "دسترسی ندارید" }, 403);
  // هم‌مبدأ بودن درخواست (دفاع اضافه در کنار SameSite)
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return json({ ok: false, error: "درخواست از مبدأ نامعتبر" }, 403);
    } catch {
      return json({ ok: false, error: "درخواست از مبدأ نامعتبر" }, 403);
    }
  }
  if (!(req.headers.get("content-type") || "").includes("multipart/form-data")) return json({ ok: false, error: "نوع درخواست نامعتبر است" }, 415);
  if (Number(req.headers.get("content-length") || 0) > MAX_FILE_BYTES * MAX_FILES + 100_000) return json({ ok: false, error: "حجم درخواست زیاد است" }, 413);
  if (!rateLimit(`kb-up:${team.id}`, 12, 60_000).ok) return json({ ok: false, error: "آپلودهای پشت‌سرهم زیاد بود؛ کمی صبر کنید" }, 429);

  const fd = await req.formData().catch(() => null);
  if (!fd) return json({ ok: false, error: "فرم نامعتبر است" }, 400);
  const files = fd.getAll("files").filter((f): f is File => typeof f !== "string" && f.size >= 0).slice(0, MAX_FILES);
  if (files.length === 0) return json({ ok: false, error: "فایلی انتخاب نشده است" }, 422);
  const kindRaw = String(fd.get("kind") || "sample");
  const kind = isKind(kindRaw) ? kindRaw : "sample";
  const redact = fd.get("redact") !== "off";

  const results: { name: string; ok: boolean; error?: string; redactions?: number; truncated?: boolean }[] = [];
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      results.push({ name: f.name, ok: false, error: "حجم فایل بیش از ۳ مگابایت است" });
      continue;
    }
    const ex = extractText(Buffer.from(await f.arrayBuffer()), f.name);
    if (!ex.ok) {
      results.push({ name: f.name, ok: false, error: ex.error });
      continue;
    }
    const r = await addDoc({
      workspaceId: team.workspaceId,
      userId: team.id,
      title: f.name.replace(/\.[^.]+$/, ""),
      kind,
      source: "upload",
      fileName: f.name,
      rawText: ex.text,
      redact,
    });
    results.push(r.ok ? { name: f.name, ok: true, redactions: r.redactions, truncated: r.truncated } : { name: f.name, ok: false, error: r.error });
  }
  const okCount = results.filter((r) => r.ok).length;
  if (okCount) {
    await logAudit({ action: "ai.knowledge.added", workspaceId: team.workspaceId, userId: team.id, detail: `${okCount} فایل` });
    revalidatePath("/admin/knowledge");
  }
  return json({ ok: okCount > 0, results }, okCount > 0 ? 200 : 422);
}

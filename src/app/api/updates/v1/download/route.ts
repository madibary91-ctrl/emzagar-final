import fs from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { clientIpFrom } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { LICENSE_KEY_RE } from "@/modules/license/crypto";
import { evaluateLicense, licenseServerEnabled, releaseByVersion, releaseFilePath } from "@/modules/license/server";

export const dynamic = "force-dynamic";
const json = (b: unknown, status: number) => NextResponse.json(b, { status, headers: { "Cache-Control": "no-store" } });

/** POST { key, domain, version } ← فایل zip نسخه (کلید لایسنس در بدنه است، نه در آدرس؛ تا در لاگ‌ها نیفتد) */
export async function POST(req: Request) {
  if (!licenseServerEnabled()) return json({ ok: false, error: "not_found" }, 404);
  const ip = clientIpFrom((n) => req.headers.get(n));
  if (!rateLimit(`dl:${ip}`, 12, 60_000).ok) return json({ ok: false, error: "rate_limited" }, 429);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const key = str(body?.key, 60).toUpperCase();
  if (!LICENSE_KEY_RE.test(key)) return json({ ok: false, error: "invalid_license" }, 403);
  const verdict = await evaluateLicense({ key, domain: str(body?.domain, 253), instanceId: "", version: "", ip, touch: false });
  if (!verdict.valid) return json({ ok: false, error: verdict.status }, 403);

  const rel = await releaseByVersion(str(body?.version, 20));
  if (!rel || rel.yanked || !rel.fileName) return json({ ok: false, error: "release_not_found" }, 404);
  // «دسترسی به آپدیت تا تاریخ …»: فقط نسخه‌هایی که پیش از آن منتشر شده‌اند
  if (verdict.updatesUntil && rel.publishedAt.getTime() > new Date(verdict.updatesUntil).getTime()) return json({ ok: false, error: "updates_expired" }, 403);
  const file = releaseFilePath(rel.fileName);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return json({ ok: false, error: "file_missing" }, 404);
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: { "Content-Type": "application/zip", "Content-Length": String(size), "Cache-Control": "no-store", "X-Release-Sha256": rel.sha256, "X-Content-Type-Options": "nosniff" },
  });
}

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";
import { getPlatformAdminForApi } from "@/modules/platform/admin";
import { isValidVersion } from "@/lib/version";
import { licenseServerEnabled, RELEASES_DIR, saveRelease } from "@/modules/license/server";
import { logAudit } from "@/modules/audit/service";

export const dynamic = "force-dynamic";
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "Cache-Control": "no-store" } });
const MAX_BYTES = 600 * 1024 * 1024;

/**
 * انتشار نسخه‌ی جدید (فقط مدیر کل روی سرور لایسنس): بدنه‌ی درخواست خودِ فایل zip است و جریانی روی دیسک نوشته می‌شود
 * (حافظه‌ی سرور با فایل‌های بزرگ پر نمی‌شود). PUT /api/platform/releases?version=2.1.0&channel=stable&security=0&changelog=…
 */
export async function PUT(req: Request) {
  if (!licenseServerEnabled()) return json({ ok: false, error: "سرور لایسنس فعال نیست" }, 404);
  const admin = await getPlatformAdminForApi();
  if (!admin) return json({ ok: false, error: "دسترسی ندارید" }, 403);
  // محافظت CSRF: فقط درخواست هم‌مبدأ
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return json({ ok: false, error: "درخواست نامعتبر" }, 403);

  const q = new URL(req.url).searchParams;
  const version = (q.get("version") || "").trim();
  if (!isValidVersion(version)) return json({ ok: false, error: "قالب نسخه نامعتبر است (مثل 2.1.0)" }, 422);
  if (!req.body) return json({ ok: false, error: "فایل ارسال نشد" }, 422);
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) return json({ ok: false, error: "حجم فایل بیش از حد مجاز است" }, 413);

  fs.mkdirSync(RELEASES_DIR, { recursive: true, mode: 0o700 });
  const fileName = `emzagar-${version}.zip`;
  const tmp = path.join(RELEASES_DIR, `.${fileName}.${process.pid}.tmp`);
  const hash = crypto.createHash("sha256");
  let size = 0;
  let head = Buffer.alloc(0);
  try {
    await pipeline(
      Readable.fromWeb(req.body as import("node:stream/web").ReadableStream),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > MAX_BYTES) return cb(new Error("حجم فایل بیش از حد مجاز است"));
          if (head.length < 4) head = Buffer.concat([head, chunk]).subarray(0, 4);
          hash.update(chunk);
          cb(null, chunk);
        },
      }),
      fs.createWriteStream(tmp, { mode: 0o600 }),
    );
    if (size < 100 || head.toString("latin1", 0, 2) !== "PK") throw new Error("فایل zip معتبر نیست");
    fs.renameSync(tmp, path.join(RELEASES_DIR, fileName));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return json({ ok: false, error: e instanceof Error ? e.message : "آپلود ناموفق بود" }, 422);
  }
  const sha256 = hash.digest("hex");
  await saveRelease({ version, channel: q.get("channel") || "stable", changelog: q.get("changelog") || "", security: q.get("security") === "1", fileName, sha256, size });
  await logAudit({ workspaceId: 0, userId: admin.id, action: "release.published", detail: `انتشار نسخه ${version} (${size} بایت)` });
  return json({ ok: true, version, sha256, size });
}

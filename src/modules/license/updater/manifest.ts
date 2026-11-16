import path from "node:path";
import { isValidVersion } from "@/lib/version";
import { MAX_ZIP, UPDATES_DIR } from "./paths";

/**
 * C-01 — اعتبارسنجی مانیفست به‌روزرسانی در «سمت کلاینت».
 * حتی پس از راستی‌آزمایی امضای Ed25519، هر فیلد مانیفست «ورودی بیرونی» حساب می‌شود (سرور فروشنده می‌تواند
 * نفوذ کرده باشد یا کلید خصوصی‌اش لو رفته باشد؛ پس نباید بتواند مسیر فایل یا هش بی‌ریخت تحمیل کند).
 */
export interface UpdateManifest {
  version: string;
  changelog: string;
  publishedAt: string;
  size: number;
  sha256: string;
  security: boolean;
}

export const SHA256_RE = /^[0-9a-f]{64}$/;

export function parseManifest(raw: unknown): UpdateManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const version = typeof r.version === "string" ? r.version.trim() : "";
  const sha256 = typeof r.sha256 === "string" ? r.sha256.trim().toLowerCase() : "";
  const size = typeof r.size === "number" ? r.size : Number.NaN;
  if (!isValidVersion(version)) return null;
  if (!SHA256_RE.test(sha256)) return null;
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ZIP) return null;
  return {
    version,
    sha256,
    size,
    changelog: typeof r.changelog === "string" ? r.changelog.slice(0, 5000) : "",
    publishedAt: typeof r.publishedAt === "string" ? r.publishedAt.slice(0, 40) : "",
    security: r.security === true,
  };
}

/** مسیر فایل دانلود؛ خارج از UPDATES_DIR رفتن (Path Traversal) خطا می‌دهد */
export function updateZipPath(version: string): string {
  if (!isValidVersion(version)) throw new Error("قالب نسخه‌ی اعلام‌شده توسط سرور نامعتبر است؛ دانلود انجام نشد.");
  const base = path.resolve(UPDATES_DIR);
  const file = path.resolve(base, `emzagar-${version}.zip`);
  if (path.dirname(file) !== base) throw new Error("مسیر فایل به‌روزرسانی نامعتبر است.");
  return file;
}

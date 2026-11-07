import { sha256 } from "@/lib/password";

/**
 * اثر انگشت سند (SHA-256). فرمول قدیمی (بدون فیلد) دقیقاً حفظ شده تا استعلام قراردادهای قبلی معتبر بماند؛
 * اگر قرارداد فیلد پرشده داشته باشد، مقدارها هم (به‌ترتیب کلید) در هش لحاظ می‌شوند.
 */
export function docFingerprint(
  bodyHtml: string,
  signers: { userId: number; signedAt: Date | null; ip: string | null }[],
  fields: { key: string; value: string }[] = [],
): string {
  let base = bodyHtml + signers.map((s) => `${s.userId}|${s.signedAt?.toISOString()}|${s.ip}`).join(";");
  if (fields.length > 0) {
    base += `|F|${[...fields].sort((a, b) => a.key.localeCompare(b.key)).map((f) => `${f.key}=${f.value}`).join(";")}`;
  }
  return sha256(base);
}

/** اثر انگشت الحاقیه: وابسته به هش قرارداد اصلی، متن الحاقیه و تأییدهای ثبت‌شده */
export function amendmentFingerprint(
  contractDocHash: string,
  seq: number,
  bodyHtml: string,
  acceptances: { userId: number; decidedAt: Date | null; ip: string | null }[],
): string {
  return sha256(`${contractDocHash}|A${seq}|${bodyHtml}|${acceptances.map((a) => `${a.userId}|${a.decidedAt?.toISOString()}|${a.ip}`).join(";")}`);
}

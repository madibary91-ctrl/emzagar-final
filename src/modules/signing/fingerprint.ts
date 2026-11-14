import { sha256 } from "@/lib/password";

/**
 * اثر انگشت سند (SHA-256). فرمول قدیمی (بدون فیلد) دقیقاً حفظ شده تا استعلام قراردادهای قبلی معتبر بماند؛
 * اگر قرارداد فیلد پرشده داشته باشد، مقدارها هم (به‌ترتیب کلید) در هش لحاظ می‌شوند.
 */
export interface FingerprintSigner {
  userId: number;
  signedAt: Date | null;
  ip: string | null;
  /** شواهد افزوده‌ی «فاز مهر/شاهد/پاراف»: فقط وقتی وجود دارند در هش می‌آیند (قراردادهای قبلی دقیقاً همان هش قبلی را دارند) */
  role?: string | null;
  sealSha256?: string | null;
  initialsSha256?: string | null;
}

export function docFingerprint(bodyHtml: string, signers: FingerprintSigner[], fields: { key: string; value: string }[] = []): string {
  let base =
    bodyHtml +
    signers
      .map((s) => {
        let part = `${s.userId}|${s.signedAt?.toISOString()}|${s.ip}`;
        // نقش شاهد، مهر و پاراف بخشی از «اثر انگشت» سند هستند؛ تعویض یا حذف آن‌ها هش را عوض می‌کند
        if (s.role === "witness") part += "|W";
        if (s.sealSha256) part += `|S:${s.sealSha256}`;
        if (s.initialsSha256) part += `|I:${s.initialsSha256}`;
        return part;
      })
      .join(";");
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

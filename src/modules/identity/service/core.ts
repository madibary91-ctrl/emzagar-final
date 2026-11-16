import { type IdentityReq, MAX_SHAHKAR_ATTEMPTS, maskNc, needsDocs, needsShahkar, parseIdentityReq } from "../rules";
import { contractSigners, signerIdentities } from "@/db/schema";
import crypto from "node:crypto";
import { db } from "@/db";
import { decryptSecret } from "@/lib/crypto";
import { eq } from "drizzle-orm";
import { getSecret } from "@/lib/secret";
import { shahkarAvailable } from "../provider";

/**
 * احراز هویت اختیاری امضاکننده — منطق سرور.
 *
 * مدل تهدید: مهاجم لینک امضا و/یا یک سیم‌کارت دارد، ولی سیم‌کارت به نام «طرف قرارداد» نیست
 * (یا طرف قرارداد بعداً امضا را انکار می‌کند). لایه‌ها:
 *   ۱) لینک اختصاصی  ۲) OTP روی موبایل (تصاحب خط)  ۳) کد ملی مورد انتظار (دانش؛ صادرکننده اعلام می‌کند)
 *   ۴) شاهکار: «خط به نام همین کد ملی است»  ۵) مدارک: عکس کارت ملی + سلفی با تأیید انسانی صادرکننده
 * هر امضا با «مهر یکپارچگی» (هش شواهد) در شناسنامه‌ی دیجیتال و لاگ ممیزی ثبت می‌شود.
 * هیچ‌یک از این‌ها برای قراردادهای سطح «عادی» اجرا نمی‌شود (صفر پرسش اضافه روی مسیر سریع).
 */

/** تنظیم نامعتبر سطح هویت هنگام صدور (کد ملی نادرست، شاهکار غیرفعال)؛ API آن را 422 برمی‌گرداند */
export class IdentityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityConfigError";
  }
}
export type IdentityRow = typeof signerIdentities.$inferSelect;
export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
export const ncHash = (nc: string) => crypto.createHmac("sha256", getSecret()).update(`signer-nc:${nc}`).digest("hex");
const fileKey = () => crypto.createHash("sha256").update(`emz-signer-identity-file-v1:${getSecret()}`).digest();
export const validMobile = (m: string | null | undefined): m is string => !!m && /^09\d{9}$/.test(m);
export function encryptBuf(buf: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", fileKey(), iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}
export function decryptBuf(buf: Buffer): Buffer {
  const d = crypto.createDecipheriv("aes-256-gcm", fileKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}
/* ───────── خواندن وضعیت ───────── */

export async function getIdentity(signerId: number): Promise<IdentityRow | null> {
  const [row] = await db.select().from(signerIdentities).where(eq(signerIdentities.signerId, signerId));
  return row ?? null;
}
/** آیا شواهد برای الزام داده‌شده کافی است؟ موبایلِ امضاکننده باید همانی باشد که تطبیق شد (تغییر شماره = ابطال) */
export function requirementMet(req: string, row: IdentityRow | null, mobile: string): boolean {
  if (req === "none") return true;
  if (!row) return false;
  if (needsShahkar(req) && !(row.shahkarStatus === "matched" && row.checkedMobile === mobile)) return false;
  if (needsDocs(req) && row.docStatus !== "approved") return false;
  return true;
}
/** سد سمت سرور پیش از ثبت هر امضا (حساب کاربری، لینک امن، API) */
export async function identityGate(signerId: number, mobile: string): Promise<{ error: string | null; req: IdentityReq }> {
  const [s] = await db.select({ req: contractSigners.identityReq }).from(contractSigners).where(eq(contractSigners.id, signerId));
  const req = parseIdentityReq(s?.req);
  if (req === "none") return { error: null, req };
  const row = await getIdentity(signerId);
  if (requirementMet(req, row, mobile)) return { error: null, req };
  const missing: string[] = [];
  if (needsShahkar(req) && !(row?.shahkarStatus === "matched" && row.checkedMobile === mobile)) missing.push("تطبیق شماره‌ی موبایل با کد ملی");
  if (needsDocs(req) && row?.docStatus !== "approved") missing.push(row?.docStatus === "pending" ? "تأیید مدارک هویتی توسط صادرکننده" : "ارسال و تأیید مدارک هویتی");
  return { error: `صادرکننده‌ی این قرارداد تأیید هویت را الزامی کرده است. ابتدا انجام شود: ${missing.join(" و ")}`, req };
}
export type GateView = {
  req: IdentityReq;
  met: boolean;
  shahkar: "none" | "matched" | "mismatch" | "error";
  attemptsLeft: number;
  hasExpected: boolean;
  docStatus: "none" | "pending" | "approved" | "rejected";
  docRejectReason: string;
  shahkarAvailable: boolean;
  ncMask: string;
};
/** نمای امن برای رابط امضاکننده (هیچ داده‌ی حساسی در آن نیست) */
export async function getGateView(signerId: number, mobile: string): Promise<GateView | null> {
  const [s] = await db.select({ req: contractSigners.identityReq }).from(contractSigners).where(eq(contractSigners.id, signerId));
  const req = parseIdentityReq(s?.req);
  if (req === "none") return null;
  const row = await getIdentity(signerId);
  const shahkarOk = row?.shahkarStatus === "matched" && row.checkedMobile === mobile;
  return {
    req,
    met: requirementMet(req, row, mobile),
    shahkar: shahkarOk ? "matched" : ((row?.shahkarStatus === "mismatch" ? "mismatch" : row?.shahkarStatus === "error" ? "error" : "none") as GateView["shahkar"]),
    attemptsLeft: Math.max(0, MAX_SHAHKAR_ATTEMPTS - (row?.attempts ?? 0)),
    hasExpected: !!row?.expectedNcHash,
    docStatus: (row?.docStatus ?? "none") as GateView["docStatus"],
    docRejectReason: row?.docRejectReason ?? "",
    shahkarAvailable: await shahkarAvailable(),
    ncMask: row?.ncEnc ? maskNc(decryptSecret(row.ncEnc)) : "",
  };
}

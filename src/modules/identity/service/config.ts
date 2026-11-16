import { IdentityConfigError, type Result, getIdentity, ncHash, requirementMet } from "./core";
import { type IdentityReq, isValidNationalCode, maskNc, needsDocs, needsShahkar, normalizeNationalCode, parseIdentityReq } from "../rules";
import { and, eq } from "drizzle-orm";
import { contractSigners, contracts, signerIdentities, users } from "@/db/schema";
import { db } from "@/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { logAudit } from "@/modules/audit/service";
import { shahkarAvailable } from "../provider";

/* ───────── تنظیم الزام توسط صادرکننده ───────── */

type ConfigureInput = { contractId: number; signerId: number; workspaceId: number; req: IdentityReq; expectedNc?: string | null; actorId?: number | null };
/** هسته‌ی تنظیم (بدون سنجش وضعیت قرارداد)؛ هم هنگام صدور و هم از صفحه‌ی قرارداد استفاده می‌شود */
export async function configureSignerIdentity(p: ConfigureInput): Promise<Result> {
  const req = parseIdentityReq(p.req);
  let expected = "";
  if (p.expectedNc && p.expectedNc.trim()) {
    expected = normalizeNationalCode(p.expectedNc);
    if (!isValidNationalCode(expected)) return { ok: false, error: "کد ملی واردشده معتبر نیست" };
  }
  if (needsShahkar(req) && !(await shahkarAvailable())) {
    return { ok: false, error: "استعلام خودکار شاهکار روی این سامانه فعال نیست؛ سطح «تأیید مدارک هویتی» را انتخاب کنید یا از مدیر پلتفرم بخواهید سرویس را فعال کند" };
  }
  const existing = await getIdentity(p.signerId);
  const newHash = expected ? ncHash(expected) : null;
  const expectedChanged = (existing?.expectedNcHash ?? null) !== newHash;

  if (req === "none" && !existing) return { ok: true };
  const reset = existing && expectedChanged
    ? { shahkarStatus: "none", shahkarRef: "", shahkarAt: null, checkedMobile: null, attempts: 0, docStatus: "none", docRejectReason: "", ncEnc: null, ncHash: null, verifiedAt: null }
    : {};
  if (!existing) {
    await db
      .insert(signerIdentities)
      .values({ signerId: p.signerId, contractId: p.contractId, workspaceId: p.workspaceId, expectedNcEnc: expected ? encryptSecret(expected) : null, expectedNcHash: newHash })
      .onConflictDoNothing();
  } else {
    await db
      .update(signerIdentities)
      .set({ expectedNcEnc: expected ? encryptSecret(expected) : null, expectedNcHash: newHash, updatedAt: new Date(), ...reset })
      .where(eq(signerIdentities.signerId, p.signerId));
  }
  await db.update(contractSigners).set({ identityReq: req }).where(eq(contractSigners.id, p.signerId));
  await refreshVerified(p.signerId);
  await logAudit({
    action: "identity.required",
    contractId: p.contractId,
    workspaceId: p.workspaceId,
    userId: p.actorId ?? null,
    detail: `سطح هویت امضاکننده #${p.signerId}: ${req}${expected ? " — با کد ملی مورد انتظار (" + maskNc(expected) + ")" : ""}`,
  });
  return { ok: true };
}
/** تغییر سطح از صفحه‌ی قرارداد: فقط پیش از امضای همان نفر و تا وقتی قرارداد باز است */
export async function setRequirement(p: ConfigureInput): Promise<Result> {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, p.contractId), eq(contracts.workspaceId, p.workspaceId)));
  if (!c) return { ok: false, error: "قرارداد یافت نشد" };
  if (c.status !== "draft" && c.status !== "sent") return { ok: false, error: "پس از پایان قرارداد، سطح هویت قابل تغییر نیست" };
  const [s] = await db.select().from(contractSigners).where(and(eq(contractSigners.id, p.signerId), eq(contractSigners.contractId, p.contractId)));
  if (!s) return { ok: false, error: "امضاکننده یافت نشد" };
  if (s.status !== "pending") return { ok: false, error: "این امضاکننده قبلاً تصمیم خود را ثبت کرده و سطح او تغییرناپذیر است" };
  return configureSignerIdentity(p);
}
/** سطح و کد ملی مورد انتظار را روی «همه‌ی امضاکنندگانِ مشتری» اعمال می‌کند؛ هنگام صدور قرارداد (داخل تراکنش صدور) */
export async function applyIdentityAtIssue(p: { contractId: number; workspaceId: number; signerId: number; req: IdentityReq; expectedNc?: string | null; actorId?: number | null }) {
  const r = await configureSignerIdentity(p);
  if (!r.ok) throw new IdentityConfigError(r.error);
}
export async function refreshVerified(signerId: number) {
  const [s] = await db.select({ req: contractSigners.identityReq, mobile: contractSigners.mobile, userMobile: users.mobile }).from(contractSigners).innerJoin(users, eq(users.id, contractSigners.userId)).where(eq(contractSigners.id, signerId));
  const row = await getIdentity(signerId);
  if (!s || !row) return;
  const met = requirementMet(parseIdentityReq(s.req), row, s.userMobile);
  await db.update(signerIdentities).set({ verifiedAt: met ? (row.verifiedAt ?? new Date()) : null, updatedAt: new Date() }).where(eq(signerIdentities.signerId, signerId));
}
/** هنگام «کپی/صدور مجدد»: سطح و کد ملی مورد انتظار به نسخه‌ی جدید منتقل می‌شود (شواهد منتقل نمی‌شود)؛ اگر شاهکار دیگر در دسترس نباشد به سطح قابل‌اجرا تنزل می‌یابد */
export async function carryOverRequirement(signerId: number): Promise<{ req: IdentityReq; expectedNc: string } | null> {
  const [s] = await db.select({ req: contractSigners.identityReq }).from(contractSigners).where(eq(contractSigners.id, signerId));
  let req = parseIdentityReq(s?.req);
  if (req === "none") return null;
  if (needsShahkar(req) && !(await shahkarAvailable())) req = needsDocs(req) ? "document" : "none";
  if (req === "none") return null;
  const row = await getIdentity(signerId);
  return { req, expectedNc: row?.expectedNcEnc ? decryptSecret(row.expectedNcEnc) : "" };
}

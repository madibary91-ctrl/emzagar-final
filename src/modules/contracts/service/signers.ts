import { asc, eq } from "drizzle-orm";
import { contractSigners, users } from "@/db/schema";
import { currentStageSigners, turnForUser } from "@/modules/signing/stages";
import { db } from "@/db";

export async function getSigners(contractId: number) {
  return db
    .select({
      id: contractSigners.id,
      contractId: contractSigners.contractId,
      position: contractSigners.position,
      label: contractSigners.label,
      userId: contractSigners.userId,
      status: contractSigners.status,
      signedAt: contractSigners.signedAt,
      ip: contractSigners.ip,
      userAgent: contractSigners.userAgent,
      signatureFile: contractSigners.signatureFile,
      signatureMethod: contractSigners.signatureMethod,
      otpVerifiedAt: contractSigners.otpVerifiedAt,
      mobile: contractSigners.mobile,
      identityReq: contractSigners.identityReq,
      identityAssurance: contractSigners.identityAssurance,
      role: contractSigners.role,
      stage: contractSigners.stage,
      signerType: contractSigners.signerType,
      companyName: contractSigners.companyName,
      companyNationalId: contractSigners.companyNationalId,
      signatoryTitle: contractSigners.signatoryTitle,
      sealRequired: contractSigners.sealRequired,
      sealFile: contractSigners.sealFile,
      sealSha256: contractSigners.sealSha256,
      initialsRequired: contractSigners.initialsRequired,
      initialsFile: contractSigners.initialsFile,
      initialsSha256: contractSigners.initialsSha256,
      userName: users.name,
      userEmail: users.email,
    })
    .from(contractSigners)
    .innerJoin(users, eq(users.id, contractSigners.userId))
    .where(eq(contractSigners.contractId, contractId))
    .orderBy(asc(contractSigners.position));
}
export type SignerRow = Awaited<ReturnType<typeof getSigners>>[number];
/**
 * نوبت امضا: اولین امضاکننده‌ی «مرحله‌ی فعلی». در امضای ترتیبی همان اولین امضاکننده‌ی باقی‌مانده است؛
 * در امضای هم‌زمان چند نفر هم‌زمان نوبت دارند (`currentSigners`) و این تابع نخستین آن‌هاست.
 */
export function currentSigner(signers: SignerRow[]) {
  return currentStageSigners(signers)[0] ?? null;
}
/** همه‌ی کسانی که «همین حالا» می‌توانند امضا کنند (امضای هم‌زمان) */
export function currentSigners(signers: SignerRow[]) {
  return currentStageSigners(signers);
}
/** نوبتِ یک کاربرِ مشخص (در امضای هم‌زمان ممکن است نفر اول مرحله نباشد) */
export function signerTurnForUser(signers: SignerRow[], userId: number) {
  return turnForUser(signers, userId);
}

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { contracts, contractSigners, signingLinks, users } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { sendSms } from "@/modules/sms";
import { signingUrl, TOKEN_RE } from "@/modules/signing/links";

/**
 * مهمان ایمیل ندارد؛ پس هنگام نهایی‌شدن قرارداد، یک پیامک با همان لینک اختصاصی می‌گیرد
 * (باز کردن لینک + OTP پیامکی ← دریافت PDF رسمی).
 */
export async function smsFinalCopyToGuests(contractId: number): Promise<number> {
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  if (!contract || contract.status !== "signed") return 0;
  const rows = await db
    .select({ signerId: contractSigners.id, mobile: users.mobile })
    .from(contractSigners)
    .innerJoin(users, eq(users.id, contractSigners.userId))
    .where(and(eq(contractSigners.contractId, contractId), eq(users.isGuest, true), eq(contractSigners.status, "signed")));
  let sent = 0;
  for (const r of rows) {
    const [link] = await db
      .select()
      .from(signingLinks)
      .where(and(eq(signingLinks.signerId, r.signerId), isNull(signingLinks.revokedAt)))
      .orderBy(desc(signingLinks.createdAt))
      .limit(1);
    if (!link || !/^09\d{9}$/.test(r.mobile)) continue;
    let token = "";
    try {
      token = decryptSecret(link.tokenEnc);
    } catch {
      continue;
    }
    if (!TOKEN_RE.test(token)) continue;
    const url = await signingUrl(token, contract.workspaceId);
    const res = await sendSms({ to: r.mobile, text: `قرارداد ${contract.number} توسط همه‌ی طرفین امضا شد. دریافت نسخه‌ی نهایی: ${url}\nهمه‌ی اسناد شما در کیف اسناد: ${new URL(url).origin}/vault` }, contractId, contract.workspaceId);
    if (res.ok) sent++;
  }
  return sent;
}

import { expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { otpCodes, subscriptions, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { getSigners, issueContract, type IssueParams } from "@/modules/contracts/service";
import { createWorkspace, ensureClient } from "@/modules/tenancy/service";
import { getOrCreateSigningLink } from "@/modules/signing/links";
import { guestSendOtpAction, guestSignAction, guestVerifyOtpAction } from "@/modules/signing/guest-actions";
import { freshBrowser, makePng, uniq } from "./helpers";

/** مالک + فضای کاری تازه برای هر فایل آزمون */
export async function setupWorkspace(name = "فضای آزمون") {
  const [owner] = await db
    .insert(users)
    .values({ name: "مالک", email: `${uniq("o")}@example.com`, mobile: "09120000009", passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() })
    .returning();
  const wsId = await createWorkspace(owner.id, name);
  // طرح نامحدود: سقف ماهانه‌ی طرح رایگان جریان آزمون‌ها را قطع نکند
  await db.insert(subscriptions).values({ workspaceId: wsId, plan: "business", currentPeriodEnd: new Date(Date.now() + 365 * 86400000) }).onConflictDoNothing();
  return { owner, wsId };
}

export async function newClient(wsId: number, name: string, mobile: string) {
  return ensureClient(wsId, { name, email: `${uniq("c")}@example.com`, mobile });
}

/** قرارداد دو امضاکننده (فروشنده ← خریدار) */
export async function newContract(wsId: number, ownerId: number, opts: Partial<IssueParams> & { body?: string } = {}) {
  const seller = await newClient(wsId, "فروشنده", "09121110001");
  const buyer = await newClient(wsId, "خریدار", "09121110002");
  const id = await issueContract({
    workspaceId: wsId,
    title: opts.title ?? "قرارداد آزمون",
    bodyHtml: opts.body ?? "<h2>موضوع</h2><p>متن آزمایشی قرارداد بین دو طرف برای آزمون خودکار.</p>",
    customerId: buyer.userId,
    extraSigners: [{ label: "فروشنده", userId: seller.userId }],
    createdBy: ownerId,
    ...opts,
  });
  return { id, signers: await getSigners(id), seller, buyer };
}

/** امضای مهمان با لینک امن (+ مقدار فیلدها) */
export async function guestSignWith(signerId: number, fields?: Record<string, string>) {
  freshBrowser();
  const link = (await getOrCreateSigningLink(signerId))!;
  const sent = await guestSendOtpAction(link.token);
  expect(sent.ok).toBe(true);
  expect((await guestVerifyOtpAction(link.token, sent.devCode!)).ok).toBe(true);
  return { token: link.token, result: await guestSignAction(link.token, { signature: makePng(), method: "draw", agree: true, fields }) };
}

/** همه‌ی امضاکنندگان به ترتیب امضا می‌کنند (fieldsBySigner: position → مقدارها) */
export async function signAll(contractId: number, fieldsByPosition: Record<number, Record<string, string>> = {}) {
  for (const s of await getSigners(contractId)) {
    const r = await guestSignWith(s.id, fieldsByPosition[s.position]);
    expect(r.result.ok, r.result.error).toBe(true);
  }
}

/** تست‌ها فاصله‌ی ارسال مجدد OTP را دور می‌زنند */
export async function clearOtps(signerId: number) {
  await db.delete(otpCodes).where(eq(otpCodes.signerId, signerId));
}

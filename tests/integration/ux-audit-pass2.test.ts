import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, contractSources, contracts, documentFields } from "@/db/schema";
import { loginAction } from "@/modules/auth/actions";
import { cancelContractAction, extendDeadlineAction, remindNowAction } from "@/modules/contracts/actions";
import { rejectContractAction, sendOtpAction } from "@/modules/signing/actions";
import { cancelContract, duplicateContract, getSigners, issueContract, removeContract } from "@/modules/contracts/service";
import { DeadlineError, extendContractDeadline, nextDeadline, parseExtendDays } from "@/modules/contracts/service/deadline";
import { runAutomation } from "@/modules/automation/service";
import { renewContract } from "@/modules/renewals/service";
import { getOrCreateSigningLink, resolveSigningToken } from "@/modules/signing/links";
import { sourcesDir } from "@/lib/storage-paths";
import { env, form, freshBrowser, run } from "../helpers";
import { newClient, setupWorkspace, signAll, guestSignWith } from "../flows";

const BODY = "<p>متن آزمایشی قرارداد برای ممیزی منطق تجاری و تجربه‌ی کاربر (پاس دوم).</p>";
const DAY = 86_400_000;

async function loginOwner(email: string) {
  freshBrowser();
  await run(() => loginAction({}, form({ email, password: "Owner123x" })));
  expect(env.cookies.has("amz_session")).toBe(true);
}

async function twoParty(wsId: number, ownerId: number, extra: Partial<Parameters<typeof issueContract>[0]> = {}) {
  const seller = await newClient(wsId, "فروشنده", "09127770001");
  const buyer = await newClient(wsId, "خریدار", "09127770002");
  const id = await issueContract({
    workspaceId: wsId,
    title: "قرارداد دو طرفه",
    bodyHtml: BODY,
    customerId: buyer.userId,
    extraSigners: [{ label: "فروشنده", userId: seller.userId }],
    createdBy: ownerId,
    ...extra,
  });
  return id;
}

describe("تمدید مهلت و بازگشایی قرارداد منقضی‌شده", () => {
  beforeEach(() => freshBrowser());

  it("منطق خالص: از پایان مهلت فعلی ادامه می‌دهد (کوتاه نمی‌کند)؛ منقضی/گذشته از «اکنون»", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    const in30 = new Date(now.getTime() + 30 * DAY);
    expect(nextDeadline({ status: "sent", expiresAt: in30 }, 7, now).getTime()).toBe(in30.getTime() + 7 * DAY);
    expect(nextDeadline({ status: "sent", expiresAt: new Date(now.getTime() - DAY) }, 7, now).getTime()).toBe(now.getTime() + 7 * DAY);
    expect(nextDeadline({ status: "expired", expiresAt: in30 }, 7, now).getTime()).toBe(now.getTime() + 7 * DAY);
  });

  it("parseExtendDays: ارقام فارسی، بازه‌ی ۱..۳۶۵ و رد ورودی نامعتبر", () => {
    expect(parseExtendDays("۱۴")).toBe(14);
    expect(parseExtendDays(" 7 ")).toBe(7);
    for (const bad of ["", "0", "-3", "366", "ab", "1.5", null, undefined, "12345"]) expect(parseExtendDays(bad), String(bad)).toBeNull();
  });

  it("تمدید قرارداد در جریان: مهلت از پایان مهلت فعلی + N روز؛ بدون مهلت = خطای روشن", async () => {
    const { owner, wsId } = await setupWorkspace("فضای تمدید");
    const id = await twoParty(wsId, owner.id, { expiryDays: 10 });
    const [before] = await db.select().from(contracts).where(eq(contracts.id, id));
    const r = await extendContractDeadline(id, owner.id, wsId, 5);
    expect(r.reopened).toBe(false);
    const [after] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(after.status).toBe("sent");
    expect(after.expiresAt!.getTime()).toBe(before.expiresAt!.getTime() + 5 * DAY);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.contractId, id));
    expect(logs.some((l) => l.action === "contract.deadline_extended")).toBe(true);

    const noExpiry = await twoParty(wsId, owner.id, { expiryDays: 0 });
    await expect(extendContractDeadline(noExpiry, owner.id, wsId, 5)).rejects.toThrow(/مهلت ندارد/);
    await expect(extendContractDeadline(id, owner.id, wsId, 0)).rejects.toBeInstanceOf(DeadlineError);
    await expect(extendContractDeadline(id, owner.id, wsId, 366)).rejects.toBeInstanceOf(DeadlineError);
  });

  it("قرارداد منقضی‌شده با همان شماره باز می‌شود، لینک تازه کار می‌کند و امضای قبلی حفظ می‌شود تا تکمیل", async () => {
    const { owner, wsId } = await setupWorkspace("فضای بازگشایی");
    const id = await twoParty(wsId, owner.id, { expiryDays: 3 });
    const [c0] = await db.select().from(contracts).where(eq(contracts.id, id));
    let signers = await getSigners(id);
    const first = signers[0];
    await guestSignWith(first.id); // فروشنده امضا می‌کند
    const oldLink = (await getOrCreateSigningLink(signers[1].id))!;
    expect((await resolveSigningToken(oldLink.token)).status).toBe("ok");

    // مهلت می‌گذرد و زمان‌بند قرارداد را منقضی می‌کند
    await db.update(contracts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(contracts.id, id));
    await runAutomation("manual", wsId);
    const [expired] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(expired.status).toBe("expired");
    expect((await resolveSigningToken(oldLink.token)).status).not.toBe("ok");

    const r = await extendContractDeadline(id, owner.id, wsId, 7);
    expect(r.reopened).toBe(true);
    const [open] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(open.status).toBe("sent");
    expect(open.number).toBe(c0.number);
    expect(open.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(open.reminderCount).toBe(0);

    signers = await getSigners(id);
    expect(signers[0].status).toBe("signed"); // امضای قبلی از بین نرفته
    const fresh = (await getOrCreateSigningLink(signers[1].id))!;
    expect((await resolveSigningToken(fresh.token)).status).toBe("ok");

    const second = await guestSignWith(signers[1].id); // نفر دوم هم امضا می‌کند ← قرارداد نهایی می‌شود
    expect(second.result.ok, second.result.error).toBe(true);
    const [done] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(done.status).toBe("signed");
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.contractId, id));
    expect(logs.some((l) => l.action === "contract.reopened")).toBe(true);
  });

  it("وضعیت‌های دیگر (لغو/امضاشده/رد) و فضای کاری دیگر قابل تمدید نیستند", async () => {
    const { owner, wsId } = await setupWorkspace("فضای تمدید ۲");
    const other = await setupWorkspace("فضای دیگر");
    const id = await twoParty(wsId, owner.id, { expiryDays: 10 });
    await expect(extendContractDeadline(id, other.owner.id, other.wsId, 3)).rejects.toThrow(/یافت نشد/);
    await cancelContract(id, owner.id, "آزمون", wsId);
    await expect(extendContractDeadline(id, owner.id, wsId, 3)).rejects.toThrow(/فقط قرارداد/);
    const signed = await twoParty(wsId, owner.id, { expiryDays: 10 });
    await signAll(signed);
    await expect(extendContractDeadline(signed, owner.id, wsId, 3)).rejects.toThrow(/فقط قرارداد/);
  });

  it("اکشن فرم: مدت نامعتبر خطای روشن می‌دهد؛ مدت معتبر قرارداد منقضی را بازمی‌کند", async () => {
    const { owner, wsId } = await setupWorkspace("فضای اکشن تمدید");
    await loginOwner(owner.email);
    const id = await twoParty(wsId, owner.id, { expiryDays: 2 });
    const bad = await run(() => extendDeadlineAction(form({ id: String(id), days: "abc" })));
    expect(bad.redirect).toMatch(/deadline_error=/);
    await db.update(contracts).set({ status: "expired", expiresAt: new Date(Date.now() - 1000) }).where(eq(contracts.id, id));
    const ok = await run(() => extendDeadlineAction(form({ id: String(id), days: "۱۴" })));
    expect(ok.redirect).toContain("deadline=reopened");
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.status).toBe("sent");
  });
});

describe("بازخورد روشن اکشن‌ها (بدون «موفقیت دروغین» و «سکوت»)", () => {
  beforeEach(() => freshBrowser());

  it("لغوِ قراردادی که دیگر در جریان نیست، دلیل را نشان می‌دهد (نه سکوت)", async () => {
    const { owner, wsId } = await setupWorkspace("فضای لغو");
    await loginOwner(owner.email);
    const id = await twoParty(wsId, owner.id);
    await signAll(id);
    await loginOwner(owner.email); // امضای مهمان نشست مرورگر را پاک می‌کند
    const r = await run(() => cancelContractAction(form({ id: String(id) })));
    expect(r.redirect).toMatch(/cancel_error=/);
    expect(decodeURIComponent(r.redirect!)).toContain("در انتظار امضا");
  });

  it("یادآوری برای قرارداد غیرفعال «ارسال شد» نمی‌گوید", async () => {
    const { owner, wsId } = await setupWorkspace("فضای یادآوری");
    const id = await twoParty(wsId, owner.id);
    await signAll(id);
    await loginOwner(owner.email);
    const r = await run(() => remindNowAction(form({ id: String(id) })));
    expect(r.redirect).toContain("remind_failed=1");
    expect(r.redirect).not.toContain("reminded=1");
  });
});

describe("یکسان بودن قانون مهلت در مسیر حساب کاربری و لینک", () => {
  it("امضاکننده‌ی واردشده هم پس از پایان مهلت (پیش از اجرای زمان‌بند) نمی‌تواند امضا کند؛ پس از تمدید می‌تواند", async () => {
    const { owner, wsId } = await setupWorkspace("فضای مهلت حساب");
    const id = await issueContract({ workspaceId: wsId, title: "مهلت‌دار", bodyHtml: BODY, customerId: owner.id, createdBy: owner.id, expiryDays: 2 });
    await loginOwner(owner.email);
    const okBefore = await sendOtpAction(id);
    expect(okBefore.error ?? "").not.toMatch(/مهلت/);
    await db.update(contracts).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(contracts.id, id)); // وضعیت هنوز sent
    const late = await sendOtpAction(id);
    expect(late.ok).toBe(false);
    expect(late.error).toMatch(/مهلت/);
    const lateReject = await rejectContractAction(id, "دیر شد");
    expect(lateReject.ok).toBe(false);
    await extendContractDeadline(id, owner.id, wsId, 3);
    const after = await sendOtpAction(id);
    expect(after.error ?? "").not.toMatch(/مهلت/);
  });
});

describe("کپی/تمدید قرارداد: داده‌ی مالی و فایل مبدأ گم نمی‌شود", () => {
  it("ارزش، برچسب و مدت اعتبار در کپی و تمدید حفظ می‌شود", async () => {
    const { owner, wsId } = await setupWorkspace("فضای کپی");
    const id = await twoParty(wsId, owner.id, { contractValue: 12_000_000, tags: "اجاره, ۱۴۰۵", termDays: 365, renewalNoticeDays: 20 });
    await signAll(id);
    const dupId = await duplicateContract(id, owner.id, wsId);
    const [d] = await db.select().from(contracts).where(eq(contracts.id, dupId));
    expect(d.status).toBe("draft");
    expect(d.contractValue).toBe(12_000_000);
    expect(d.tags.length).toBeGreaterThan(0);
    expect(d.termDays).toBe(365);
    expect(d.renewalNoticeDays).toBe(20);

    const ren = await renewContract(id, owner.id, wsId);
    const [r] = await db.select().from(contracts).where(eq(contracts.id, ren.id));
    expect(r.contractValue).toBe(12_000_000);
    expect(r.tags).toBe(d.tags);
    expect(r.termDays).toBe(365);
  });

  it("تمدید هم‌زمان (دوبار کلیک): فقط یک پیش‌نویس تمدید ساخته می‌شود", async () => {
    const { owner, wsId } = await setupWorkspace("فضای تمدید هم‌زمان");
    const id = await twoParty(wsId, owner.id, { termDays: 90 });
    await signAll(id);
    const rs = await Promise.all(Array.from({ length: 5 }, () => renewContract(id, owner.id, wsId)));
    expect(new Set(rs.map((r) => r.id)).size).toBe(1);
    expect(rs.filter((r) => !r.existing).length).toBe(1);
    const kids = await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.renewedFromId, id));
    expect(kids.length).toBe(1);
  });

  it("کپی قراردادِ «امضا روی فایل»: فایل‌ها و جای فیلدها کپی می‌شوند و حذف اصل، کپی را خراب نمی‌کند", async () => {
    const { owner, wsId } = await setupWorkspace("فضای کپی فایل");
    const id = await twoParty(wsId, owner.id);
    await fs.mkdir(sourcesDir(), { recursive: true });
    const origName = `orig-${id}.pdf`;
    const pdfName = `work-${id}.pdf`;
    await fs.writeFile(path.join(sourcesDir(), origName), "%PDF-orig");
    await fs.writeFile(path.join(sourcesDir(), pdfName), "%PDF-work");
    await db.insert(contractSources).values({ contractId: id, kind: "pdf", originalName: "a.pdf", originalFile: origName, originalSha256: "a".repeat(64), pdfFile: pdfName, pdfSha256: "b".repeat(64), size: 9, pageCount: 2, pagesMeta: "[]" });
    await db.insert(documentFields).values([
      { contractId: id, signerPosition: 1, kind: "signature", label: "امضا", page: 1, x: 1000, y: 2000, w: 2500, h: 800, required: true },
      { contractId: id, signerPosition: 2, kind: "date", label: "تاریخ", page: 2, x: 3000, y: 4000, w: 2000, h: 600, required: false },
    ]);

    const dupId = await duplicateContract(id, owner.id, wsId);
    const [src] = await db.select().from(contractSources).where(eq(contractSources.contractId, dupId));
    expect(src).toBeTruthy();
    expect(src.originalFile).not.toBe(origName);
    expect(src.pdfFile).not.toBe(pdfName);
    expect(src.originalSha256).toBe("a".repeat(64));
    expect(await fs.readFile(path.join(sourcesDir(), src.pdfFile), "utf8")).toBe("%PDF-work");
    const f = await db.select().from(documentFields).where(eq(documentFields.contractId, dupId));
    expect(f.map((x) => [x.signerPosition, x.kind, x.x, x.y, x.required]).sort()).toEqual([
      [1, "signature", 1000, 2000, true],
      [2, "date", 3000, 4000, false],
    ]);

    // حذف قرارداد اصلی فایل‌های خودش را پاک می‌کند، نه فایل‌های کپی را
    expect(await removeContract(id, owner.id, wsId)).toBe(true); // پیش‌تر بعد از پاک‌شدن همه‌چیز با خطای کلید خارجی لاگ می‌افتاد
    const delLog = (await db.select().from(auditLogs).where(eq(auditLogs.workspaceId, wsId))).filter((l) => l.action === "contract.deleted");
    expect(delLog.length).toBe(1);
    await expect(fs.access(path.join(sourcesDir(), origName))).rejects.toBeTruthy();
    expect(await fs.readFile(path.join(sourcesDir(), src.pdfFile), "utf8")).toBe("%PDF-work");
    expect(await fs.readFile(path.join(sourcesDir(), src.originalFile), "utf8")).toBe("%PDF-orig");
  });
});

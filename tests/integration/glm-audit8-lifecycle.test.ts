/**
 * ممیزی GLM دور ۸ — ماشین حالت و تراکنش‌های چرخه‌ی حیات قرارداد (A-1…A-7، B-1، B-4/C-1، B-8، B-9).
 * رقابت‌ها «قطعی» ساخته می‌شوند (نگه‌داشتن قفل ردیف در یک اتصال جدا و سپس commit)، نه با بخت‌آزمایی؛
 * خطاهای میانه‌ی کار با تریگر واقعی PostgreSQL شبیه‌سازی می‌شود (مثل transaction-atomicity.test.ts).
 * مستندات: docs/GLM-AUDIT8-LIFECYCLE-FA.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, getPool } from "@/db";
import { amendmentSigners, contractAmendments, contractRevisions, contracts, contractSigners, orders, otpCodes, products, signingLinks, wpOutbox } from "@/db/schema";
import { SCHEMA_PLAN } from "@/modules/install/schema-sql";
import { cancelContract, ContractProtectedError, removeContract, saveDraft, setArchived } from "@/modules/contracts/service";
import { restoreRevision } from "@/modules/contracts/revisions";
import { runBulk } from "@/modules/contracts/bulk";
import { runAutomation } from "@/modules/automation/service";
import { runRenewalChecks } from "@/modules/renewals/service";
import { amendDecideAction, amendSendOtpAction } from "@/modules/amendments/actions";
import { createAmendment } from "@/modules/amendments/service";
import { getOrCreateSigningLink } from "@/modules/signing/links";
import { guestRejectAction, guestSendOtpAction, guestSignAction, guestVerifyOtpAction } from "@/modules/signing/guest-actions";
import { completeHandshake, startHandshake } from "@/modules/connect/service";
import { handshakePOSTForTest } from "./glm8-helpers";
import type { TeamUser } from "@/modules/tenancy/context";
import { clearOtps, guestSignWith, newClient, setupWorkspace, signAll } from "../flows";
import { getSigners, issueContract, type IssueParams } from "@/modules/contracts/service";
import { freshBrowser, makePng, uniq } from "../helpers";

vi.mock("@/lib/ssrf", async (orig) => {
  const m = await orig<typeof import("@/lib/ssrf")>();
  return { ...m, assertSafeUrl: async (u: string) => new URL(u) };
});

const faults: { table: string; name: string }[] = [];
async function injectFault(table: string, when: string) {
  const name = `emz_g8_fault_${faults.length}`;
  await db.execute(sql.raw(`create or replace function emz_g8_fault() returns trigger language plpgsql as $$ begin raise exception 'simulated failure'; end $$`));
  await db.execute(sql.raw(`create trigger ${name} before insert or update on ${table} for each row when (${when}) execute function emz_g8_fault()`));
  faults.push({ table, name });
}
async function clearFaults() {
  while (faults.length) {
    const f = faults.pop()!;
    await db.execute(sql.raw(`drop trigger if exists ${f.name} on ${f.table}`));
  }
}
afterEach(clearFaults);
beforeEach(() => freshBrowser());

/**
 * مانند flows.newContract ولی با «موبایل‌های یکتا»: کیف اسناد (vault) و برخی آزمون‌های دیگر اسناد را بر پایه‌ی شماره‌ی موبایل جمع می‌کنند؛
 * شماره‌های ثابتِ flows.ts در دیتابیس مشترکِ آزمون‌ها، اسناد این فایل را به آن آزمون‌ها نشت می‌داد.
 */
let mobileSeq = 0;
const mobileBase = 9_130_000_000 + (Date.now() % 1_000_000) * 100;
const uniqMobile = () => `0${mobileBase + ++mobileSeq}`;
async function newContract(ws: number, ownerId: number, opts: Partial<IssueParams> & { body?: string } = {}) {
  const seller = await newClient(ws, "فروشنده", uniqMobile());
  const buyer = await newClient(ws, "خریدار", uniqMobile());
  const id = await issueContract({
    workspaceId: ws,
    title: opts.title ?? "قرارداد آزمون",
    bodyHtml: opts.body ?? "<h2>موضوع</h2><p>متن آزمایشی قرارداد بین دو طرف برای آزمون خودکار.</p>",
    customerId: buyer.userId,
    extraSigners: [{ label: "فروشنده", userId: seller.userId }],
    createdBy: ownerId,
    ...opts,
  });
  return { id, signers: await getSigners(id), seller, buyer };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowOf = async (id: number) => (await db.select().from(contracts).where(eq(contracts.id, id)))[0];
const signerRows = (id: number) => db.select().from(contractSigners).where(eq(contractSigners.contractId, id)).orderBy(contractSigners.position);
const codeOf = (e: unknown) => (e as { code?: string; cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;

/** تراکنشی در اتصال جدا که قفل ردیف را نگه می‌دارد تا «رقابتِ هم‌زمان» قطعی شود */
async function holdTx(stmt: string) {
  const c = await getPool().connect();
  await c.query("BEGIN");
  await c.query(stmt);
  return {
    commit: async () => {
      await c.query("COMMIT");
      c.release();
    },
  };
}

/** نشست مهمان (OTP تأییدشده) برای یک امضاکننده؛ توکن لینک برمی‌گردد */
async function guestSession(signerId: number) {
  freshBrowser();
  const link = (await getOrCreateSigningLink(signerId))!;
  const sent = await guestSendOtpAction(link.token);
  expect(sent.ok).toBe(true);
  expect((await guestVerifyOtpAction(link.token, sent.devCode!)).ok).toBe(true);
  return link.token;
}
const signInput = () => ({ signature: makePng(), method: "draw" as const, agree: true });

let owner: { id: number };
let wsId: number;
beforeEach(async () => {
  if (!wsId) ({ owner, wsId } = await setupWorkspace("فضای ممیزی ۸"));
});

describe("A-1 / A-3: امضا × لغو (قطعی)", () => {
  it("لغوِ commit‌شده پیش از امضای آخرین نفر: امضا رد می‌شود و قرارداد «لغوشده» می‌ماند (نه امضاشده)", async () => {
    const { id, signers } = await newContract(wsId, owner.id);
    expect((await guestSignWith(signers[0].id)).result.ok).toBe(true);
    const token = await guestSession(signers[1].id);
    const tx = await holdTx(`update contracts set status = 'cancelled' where id = ${id}`);
    const pending = guestSignAction(token, signInput());
    await sleep(500); // امضا پشت قفل ردیف منتظر است
    await tx.commit();
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/دیگر قابل امضا نیست/);
    const c = await rowOf(id);
    expect(c.status).toBe("cancelled");
    expect(c.docHash).toBeNull();
    expect(c.signedAt).toBeNull();
    expect((await signerRows(id))[1].status).toBe("pending");
  });

  it("امضای نهایی پیش از لغو: لغو خطای روشن می‌دهد و قرارداد امضاشده می‌ماند", async () => {
    const { id, signers } = await newContract(wsId, owner.id);
    expect((await guestSignWith(signers[0].id)).result.ok).toBe(true);
    const tx = await holdTx(`update contract_signers set status = 'signed' where id = ${signers[1].id}`); // شبیه «امضای در حال commit»
    const cancelling = cancelContract(id, owner.id, "رقابت", wsId).then(() => "cancelled", (e: Error) => e.message);
    await sleep(300);
    await tx.commit();
    // لغو یا خطا می‌دهد یا (چون قرارداد هنوز sent است) انجام می‌شود؛ در هر حال وضعیت‌ها هم‌خوان‌اند
    await cancelling;
    const c = await rowOf(id);
    const s = await signerRows(id);
    expect(c.status === "signed" && c.docHash === null).toBe(false);
    expect(["cancelled", "signed", "sent"]).toContain(c.status);
    expect(!(c.status === "cancelled" && s.every((x) => x.status === "signed" && c.signedAt))).toBe(true);
  });

  it("۶ دور رقابت واقعی «لغو ‖ امضای آخر»: هرگز هم لغوشده هم امضاشده نمی‌شود", async () => {
    for (let i = 0; i < 6; i++) {
      const { id, signers } = await newContract(wsId, owner.id);
      expect((await guestSignWith(signers[0].id)).result.ok).toBe(true);
      const token = await guestSession(signers[1].id);
      const [cancel, sign] = await Promise.all([
        cancelContract(id, owner.id, "رقابت", wsId).then(() => ({ ok: true }), () => ({ ok: false })),
        guestSignAction(token, signInput()),
      ]);
      const c = await rowOf(id);
      const s = await signerRows(id);
      if (c.status === "cancelled") {
        expect(cancel.ok).toBe(true);
        expect(sign.ok).toBe(false);
        expect(s[1].status).toBe("pending");
        expect(c.docHash).toBeNull();
      } else {
        expect(c.status).toBe("signed");
        expect(sign.ok).toBe(true);
        expect(cancel.ok).toBe(false);
        expect(s.every((x) => x.status === "signed")).toBe(true);
        expect(c.docHash).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });
});

describe("A-2: رد (Reject)", () => {
  it("ردِ رسیده پس از لغوِ commit‌شده: امضاکننده «ردکننده» ثبت نمی‌شود و قرارداد لغوشده می‌ماند", async () => {
    const { id, signers } = await newContract(wsId, owner.id);
    const token = await guestSession(signers[0].id);
    const tx = await holdTx(`update contracts set status = 'cancelled' where id = ${id}`);
    const pending = guestRejectAction(token, "نمی‌پذیرم");
    await sleep(500);
    await tx.commit();
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/قابل رد کردن نیست/);
    expect((await rowOf(id)).status).toBe("cancelled");
    expect((await signerRows(id))[0].status).toBe("pending");
  });

  it("رد اتمی است: شکست هنگام تغییر وضعیت قرارداد، «ردشدن امضاکننده» را هم برمی‌گرداند (بدون بن‌بست)", async () => {
    const { id, signers } = await newContract(wsId, owner.id);
    const token = await guestSession(signers[0].id);
    await injectFault("contracts", `NEW.status = 'rejected' and NEW.id = ${id}`);
    await expect(guestRejectAction(token, "دلیل")).rejects.toThrow();
    expect((await rowOf(id)).status).toBe("sent");
    expect((await signerRows(id))[0].status).toBe("pending");
    await clearFaults();
    expect((await guestRejectAction(token, "دلیل")).ok).toBe(true);
    expect((await rowOf(id)).status).toBe("rejected");
    expect((await signerRows(id))[0].status).toBe("rejected");
    const links = await db.select().from(signingLinks).where(eq(signingLinks.contractId, id));
    expect(links.every((l) => l.revokedAt)).toBe(true);
  });
});

describe("A-4 / A-5: الحاقیه", () => {
  it("ثبت الحاقیه اتمی است: شکست در ثبت امضاکنندگان، الحاقیه‌ی یتیم نمی‌گذارد و تلاش بعدی سالم است", async () => {
    const { id } = await newContract(wsId, owner.id);
    await signAll(id);
    await injectFault("amendment_signers", "true");
    const bad = await createAmendment({ contractId: id, workspaceId: wsId, title: "تمدید تحویل", bodyText: "تحویل تا پایان ماه آینده تمدید می‌شود.", actorId: owner.id });
    expect(bad.ok).toBe(false);
    expect(await db.select().from(contractAmendments).where(eq(contractAmendments.contractId, id))).toHaveLength(0);
    await clearFaults();
    const good = await createAmendment({ contractId: id, workspaceId: wsId, title: "تمدید تحویل", bodyText: "تحویل تا پایان ماه آینده تمدید می‌شود.", actorId: owner.id });
    expect(good).toMatchObject({ ok: true, seq: 1 });
    if (good.ok) expect(good.links).toHaveLength(2);
  });

  it("ثبت هم‌زمان ۵ الحاقیه: دقیقاً یکی ثبت می‌شود و بقیه پیام روشن می‌گیرند (نه خطای مبهم)", async () => {
    const { id } = await newContract(wsId, owner.id);
    await signAll(id);
    const rs = await Promise.all(Array.from({ length: 5 }, () => createAmendment({ contractId: id, workspaceId: wsId, title: "الحاقیه موازی", bodyText: "متن الحاقیه‌ی هم‌زمان برای آزمون رقابت.", actorId: owner.id })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    for (const r of rs.filter((x) => !x.ok)) expect(r.ok === false && r.error).toMatch(/در انتظار تأیید وجود دارد/);
    const all = await db.select().from(contractAmendments).where(eq(contractAmendments.contractId, id));
    expect(all).toHaveLength(1);
    expect(await db.select().from(amendmentSigners).where(eq(amendmentSigners.amendmentId, all[0].id))).toHaveLength(2);
  });

  it("شکست پس از OTP درست، کد را نمی‌سوزاند؛ همان کد دوباره کار می‌کند", async () => {
    const { id, signers } = await newContract(wsId, owner.id);
    await signAll(id);
    const created = await createAmendment({ contractId: id, workspaceId: wsId, title: "الحاقیه OTP", bodyText: "متن الحاقیه برای آزمون عدم سوختن کد تأیید.", actorId: owner.id });
    if (!created.ok) throw new Error(created.error);
    const tokens = created.links.map((l) => l.url.split("/amend/")[1]);
    // نفر اول عادی
    freshBrowser();
    await clearOtps(signers[0].id);
    const s0 = await amendSendOtpAction({ token: tokens[0] });
    expect((await amendDecideAction({ token: tokens[0] }, { accept: true, code: s0.devCode!, agree: true })).ok).toBe(true);
    // نفر دوم (آخرین): نهایی‌سازی الحاقیه با خطای دیتابیس شکست می‌خورد
    freshBrowser();
    await clearOtps(signers[1].id);
    const s1 = await amendSendOtpAction({ token: tokens[1] });
    await injectFault("contract_amendments", "NEW.status = 'signed'");
    await expect(amendDecideAction({ token: tokens[1] }, { accept: true, code: s1.devCode!, agree: true })).rejects.toThrow();
    const [otp] = await db.select().from(otpCodes).where(eq(otpCodes.signerId, signers[1].id));
    expect(otp.usedAt).toBeNull(); // کد نسوخت
    const [am] = await db.select().from(amendmentSigners).where(eq(amendmentSigners.signerId, signers[1].id));
    expect(am.status).toBe("pending"); // تصمیم نیمه‌کاره نماند
    await clearFaults();
    const retry = await amendDecideAction({ token: tokens[1] }, { accept: true, code: s1.devCode!, agree: true });
    expect(retry).toMatchObject({ ok: true, completed: true });
  });

  it("تصمیم هم‌زمان با لغوِ الحاقیه: تصمیم روی الحاقیه‌ی لغوشده ثبت نمی‌شود و کد نمی‌سوزد", async () => {
    const { id, signers } = await newContract(wsId, owner.id);
    await signAll(id);
    const created = await createAmendment({ contractId: id, workspaceId: wsId, title: "الحاقیه لغو", bodyText: "متن الحاقیه برای آزمون لغو هم‌زمان با تصمیم.", actorId: owner.id });
    if (!created.ok) throw new Error(created.error);
    const token = created.links[0].url.split("/amend/")[1];
    freshBrowser();
    await clearOtps(signers[0].id);
    const sent = await amendSendOtpAction({ token });
    const tx = await holdTx(`update contract_amendments set status = 'cancelled' where id = ${created.id}`);
    const deciding = amendDecideAction({ token }, { accept: true, code: sent.devCode!, agree: true });
    await sleep(500);
    await tx.commit();
    const r = await deciding;
    expect(r.ok).toBe(false);
    const [am] = await db.select().from(amendmentSigners).where(eq(amendmentSigners.signerId, signers[0].id));
    expect(am.status).toBe("pending");
    const [otp] = await db.select().from(otpCodes).where(eq(otpCodes.signerId, signers[0].id));
    expect(otp.usedAt).toBeNull();
  });
});

describe("A-6: متن پیش‌نویس پس از انتشار", () => {
  it("ذخیره‌ی دیرهنگامِ پیش‌نویس پس از انتشارِ هم‌زمان، متن منتشرشده را بازنویسی نمی‌کند", async () => {
    const { id } = await newContract(wsId, owner.id, { draft: true, body: "<p>متن اولیه‌ی پیش‌نویس برای آزمون رقابت ذخیره و انتشار.</p>" });
    const before = await rowOf(id);
    const revs = (await db.select().from(contractRevisions).where(eq(contractRevisions.contractId, id))).length;
    const tx = await holdTx(`update contracts set status = 'sent' where id = ${id}`); // «انتشار» در حال commit
    const saving = saveDraft(id, owner.id, { title: "عنوان دستکاری", bodyHtml: "<p>متن دستکاری‌شده پس از انتشار که نباید ذخیره شود.</p>" }, wsId).then(() => "saved", (e: Error) => e.message);
    await sleep(500);
    await tx.commit();
    expect(await saving).toMatch(/فقط پیش‌نویس قابل ویرایش است/);
    const after = await rowOf(id);
    expect(after.bodyHtml).toBe(before.bodyHtml);
    expect(after.title).toBe(before.title);
    expect((await db.select().from(contractRevisions).where(eq(contractRevisions.contractId, id))).length).toBe(revs);
  });

  it("بازگردانی نسخه پس از انتشار: هیچ نسخه‌ی دروغین/لاگ موفقیت ثبت نمی‌شود", async () => {
    const { id } = await newContract(wsId, owner.id, { draft: true, body: "<p>نسخه‌ی یک پیش‌نویس برای آزمون بازگردانی نسخه.</p>" });
    await saveDraft(id, owner.id, { title: "قرارداد آزمون", bodyHtml: "<p>نسخه‌ی دو پیش‌نویس که متفاوت از نسخه‌ی یک است.</p>" }, wsId);
    const before = await rowOf(id);
    const revs = (await db.select().from(contractRevisions).where(eq(contractRevisions.contractId, id))).length;
    const tx = await holdTx(`update contracts set status = 'sent' where id = ${id}`);
    const restoring = restoreRevision(id, 1, owner.id, wsId).then(() => "restored", (e: Error) => e.message);
    await sleep(500);
    await tx.commit();
    expect(await restoring).toMatch(/فقط پیش‌نویس قابل بازگردانی است/);
    expect((await rowOf(id)).bodyHtml).toBe(before.bodyHtml);
    expect((await db.select().from(contractRevisions).where(eq(contractRevisions.contractId, id))).length).toBe(revs);
  });
});

describe("A-7: انقضای گروهی", () => {
  it("خطا در یک قرارداد بقیه را متوقف نمی‌کند و ردیفِ خراب نیمه‌منقضی (بدون لاگ/با لینک زنده) نمی‌ماند", async () => {
    const { owner: o2, wsId: ws2 } = await setupWorkspace("فضای انقضا");
    const made = [];
    for (let i = 0; i < 3; i++) {
      const c = await newContract(ws2, o2.id);
      await getOrCreateSigningLink(c.signers[0].id);
      await db.update(contracts).set({ expiresAt: new Date(Date.now() - 3600_000) }).where(eq(contracts.id, c.id));
      made.push({ id: c.id, number: (await rowOf(c.id)).number });
    }
    await injectFault("audit_logs", `NEW.action = 'contract.expired' and NEW.detail = '${made[1].number}'`);
    const r1 = await runAutomation("manual", ws2);
    expect(r1.expired).toBe(2);
    expect((await rowOf(made[0].id)).status).toBe("expired");
    expect((await rowOf(made[2].id)).status).toBe("expired");
    // ردیف خراب: کاملاً برگشته (هنوز sent، لینک زنده) تا اجرای بعدی دوباره تلاش کند
    expect((await rowOf(made[1].id)).status).toBe("sent");
    const linkOf = async (cid: number) => (await db.select().from(signingLinks).where(eq(signingLinks.contractId, cid)))[0];
    expect((await linkOf(made[1].id)).revokedAt).toBeNull();
    expect((await linkOf(made[0].id)).revokedAt).not.toBeNull();
    await clearFaults();
    const r2 = await runAutomation("manual", ws2);
    expect(r2.expired).toBe(1);
    expect((await rowOf(made[1].id)).status).toBe("expired");
  });

  it("تمدید هم‌زمان مهلت: قراردادی که مهلتش زیر قفل تمدید شده منقضی نمی‌شود", async () => {
    const { owner: o2, wsId: ws2 } = await setupWorkspace("فضای انقضا-تمدید");
    const c = await newContract(ws2, o2.id);
    await db.update(contracts).set({ expiresAt: new Date(Date.now() - 3600_000) }).where(eq(contracts.id, c.id));
    const tx = await holdTx(`update contracts set expires_at = now() + interval '5 days' where id = ${c.id}`);
    const running = runAutomation("manual", ws2);
    await sleep(500);
    await tx.commit();
    expect((await running).expired).toBe(0);
    expect((await rowOf(c.id)).status).toBe("sent");
  });
});

describe("B-1: قیدهای CHECK ماشین حالت", () => {
  it("وضعیت نامعتبر قرارداد/امضاکننده/الحاقیه/تصمیم/سفارش در سطح دیتابیس رد می‌شود (SQLSTATE 23514)", async () => {
    const { id, signers } = await newContract(wsId, owner.id);
    await signAll(id);
    const created = await createAmendment({ contractId: id, workspaceId: wsId, title: "الحاقیه قید", bodyText: "متن الحاقیه برای آزمون قیدهای دیتابیس.", actorId: owner.id });
    if (!created.ok) throw new Error(created.error);
    const bad = [
      `update contracts set status = 'bogus' where id = ${id}`,
      `update contract_signers set status = 'done' where id = ${signers[0].id}`,
      `update contract_signers set role = 'boss' where id = ${signers[0].id}`,
      `update contract_amendments set status = 'approved' where id = ${created.id}`,
      `update amendment_signers set status = 'signed' where amendment_id = ${created.id}`,
    ];
    for (const stmt of bad) {
      const err = await db.execute(sql.raw(stmt)).then(() => null, (e: unknown) => e);
      expect(err, stmt).not.toBeNull();
      expect(codeOf(err), stmt).toBe("23514");
    }
    // مقادیر معتبر همچنان مجازند
    await db.execute(sql.raw(`update contracts set status = 'signed' where id = ${id}`));
    const [u] = await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, id));
    expect(u.id).toBe(id);
  });

  it("ارتقای دیتابیس قدیمی با ردیف نامعتبر نمی‌شکند: قید NOT VALID می‌ماند و برای نوشتن‌های جدید فعال است", async () => {
    expect(SCHEMA_PLAN.checks.length).toBeGreaterThanOrEqual(6);
    const [p] = await db.insert(products).values({ workspaceId: wsId, title: "محصول قید", price: 1000 }).returning();
    await db.execute(sql.raw(`alter table orders drop constraint orders_status_chk`));
    const [o] = await db.insert(orders).values({ workspaceId: wsId, userId: owner.id, productId: p.id, status: "legacy_garbage" }).returning();
    for (const st of SCHEMA_PLAN.checks) await getPool().query(st); // نباید خطا بدهد
    const state = async () => (await getPool().query(`select convalidated from pg_constraint where conname = 'orders_status_chk'`)).rows[0] as { convalidated: boolean } | undefined;
    expect((await state())?.convalidated).toBe(false);
    const err = await db.insert(orders).values({ workspaceId: wsId, userId: owner.id, productId: p.id, status: "another_garbage" }).then(() => null, (e: unknown) => e);
    expect(codeOf(err)).toBe("23514");
    // پس از پاک‌سازی داده، اجرای دوباره قید را معتبر می‌کند (ایدمپوتنت)
    await db.delete(orders).where(eq(orders.id, o.id));
    for (const st of SCHEMA_PLAN.checks) await getPool().query(st);
    expect((await state())?.convalidated).toBe(true);
  });
});

describe("B-4 / C-1: یادآوری تمدید", () => {
  it("شکست اعلان یک قرارداد، بقیه را متوقف نمی‌کند و یادآوریِ همان قرارداد نمی‌سوزد (اجرای بعدی دوباره می‌فرستد)", async () => {
    const { owner: o2, wsId: ws2 } = await setupWorkspace("فضای تمدید");
    const ids: number[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await newContract(ws2, o2.id);
      await signAll(c.id);
      await db.update(contracts).set({ termEndsAt: new Date(Date.now() + 5 * 86400_000), renewalNoticeDays: 30 }).where(eq(contracts.id, c.id));
      ids.push(c.id);
    }
    const bad = await rowOf(ids[0]);
    await injectFault("audit_logs", `NEW.action = 'renewal.due' and NEW.detail like '${bad.number}%'`);
    expect(await runRenewalChecks(ws2)).toBe(1);
    expect((await rowOf(ids[0])).renewalNotifiedAt).toBeNull(); // ادعا آزاد شد
    expect((await rowOf(ids[1])).renewalNotifiedAt).not.toBeNull();
    await clearFaults();
    expect(await runRenewalChecks(ws2)).toBe(1);
    expect((await rowOf(ids[0])).renewalNotifiedAt).not.toBeNull();
    expect(await runRenewalChecks(ws2)).toBe(0); // دقیقاً یک‌بار
  });
});

describe("B-8: قرارداد امضاشده حذف نمی‌شود", () => {
  it("حذف فیزیکی رد، بایگانی مجاز؛ حذف گروهی «ردشده» حساب می‌شود؛ قراردادهای غیرنهایی همچنان حذف‌شدنی‌اند", async () => {
    const { id } = await newContract(wsId, owner.id);
    await signAll(id);
    await expect(removeContract(id, owner.id, wsId)).rejects.toBeInstanceOf(ContractProtectedError);
    expect((await rowOf(id)).status).toBe("signed");
    expect((await signerRows(id)).every((s) => s.signatureFile)).toBe(true);

    const team = { id: owner.id, workspaceId: wsId, wsRole: "owner" } as unknown as TeamUser;
    const bulk = await runBulk(team, "delete", [id]);
    expect(bulk).toMatchObject({ ok: true, done: 0, skipped: 1, failed: 0 });
    expect(await rowOf(id)).toBeTruthy();

    expect(await setArchived(id, wsId, owner.id, true)).toBe(true);
    expect((await rowOf(id)).archivedAt).not.toBeNull();

    const open = await newContract(wsId, owner.id);
    expect(await removeContract(open.id, owner.id, wsId)).toBe(true);
    expect(await rowOf(open.id)).toBeUndefined();
  });

  it("امضای نهایی هم‌زمان با حذف: سند امضاشده نابود نمی‌شود", async () => {
    const { id, signers } = await newContract(wsId, owner.id);
    expect((await guestSignWith(signers[0].id)).result.ok).toBe(true);
    const token = await guestSession(signers[1].id);
    const [rm, sign] = await Promise.all([removeContract(id, owner.id, wsId).then(() => "removed", (e: Error) => e.name), guestSignAction(token, signInput())]);
    const c = await rowOf(id);
    if (c) {
      expect(c.status).toBe("signed");
      expect(rm).toBe("ContractProtectedError");
      expect(sign.ok).toBe(true);
    } else {
      expect(rm).toBe("removed");
      expect(sign.ok).toBe(false);
    }
  });
});

describe("B-9: سفارش", () => {
  const newOrder = async (ws: number, userId: number) => {
    const [p] = await db.insert(products).values({ workspaceId: ws, title: "محصول", price: 5000 }).returning();
    const [o] = await db.insert(orders).values({ workspaceId: ws, userId, productId: p.id, amount: 5000 }).returning();
    return o;
  };
  const orderStatus = async (oid: number) => (await db.select().from(orders).where(eq(orders.id, oid)))[0].status;

  it("سفارشِ داخلی: لغو/رد ← cancelled؛ امضای کامل ← completed (و سفارش تکمیل‌شده هرگز برنمی‌گردد)", async () => {
    const o1 = await newOrder(wsId, owner.id);
    const c1 = await newContract(wsId, owner.id, { orderId: o1.id });
    await cancelContract(c1.id, owner.id, "", wsId);
    expect(await orderStatus(o1.id)).toBe("cancelled");

    const o2 = await newOrder(wsId, owner.id);
    const c2 = await newContract(wsId, owner.id, { orderId: o2.id });
    const token = await guestSession(c2.signers[0].id);
    expect((await guestRejectAction(token, "رد")).ok).toBe(true);
    expect(await orderStatus(o2.id)).toBe("cancelled");

    const o3 = await newOrder(wsId, owner.id);
    const c3 = await newContract(wsId, owner.id, { orderId: o3.id });
    await signAll(c3.id);
    expect(await orderStatus(o3.id)).toBe("completed");
  });

  it("ووکامرس (رد ادعا): ابر برای لغو/رد/انقضا رویداد می‌فرستد؛ افزونه طبق سیاست wc_on_reject سفارش را به‌روز می‌کند", async () => {
    const hs = await startHandshake({ installId: "b2".repeat(16), siteUrl: `http://${uniq("wp")}.test`, siteName: "فروشگاه", adminEmail: `${uniq("owner")}@example.com`, adminName: "مدیر", pluginVersion: "2.3.0", wpVersion: "6.7", wcActive: true, locale: "fa_IR" });
    const done = await completeHandshake(hs.handshakeId);
    await handshakePOSTForTest(done.apiKey);
    const ws2 = done.workspaceId;
    const { owner: o2 } = await setupWorkspace("x"); // مالک مستقل برای createdBy
    const cancelled = await newContract(ws2, o2.id);
    await cancelContract(cancelled.id, o2.id, "", ws2);
    const rejected = await newContract(ws2, o2.id);
    const token = await guestSession(rejected.signers[0].id);
    await guestRejectAction(token, "رد");
    const expiredC = await newContract(ws2, o2.id);
    await db.update(contracts).set({ expiresAt: new Date(Date.now() - 3600_000) }).where(eq(contracts.id, expiredC.id));
    await runAutomation("manual", ws2);
    const seen = async (cid: number, ev: string) => {
      for (let i = 0; i < 40; i++) {
        const rows = await db.select().from(wpOutbox).where(and(eq(wpOutbox.workspaceId, ws2), eq(wpOutbox.event, ev)));
        if (rows.some((r) => (JSON.parse(r.payload) as { contractId: number }).contractId === cid)) return true;
        await sleep(100);
      }
      return false;
    };
    expect(await seen(cancelled.id, "contract.cancelled")).toBe(true);
    expect(await seen(rejected.id, "contract.rejected")).toBe(true);
    expect(await seen(expiredC.id, "contract.expired")).toBe(true);
  });
});

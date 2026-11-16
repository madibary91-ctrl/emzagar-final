/**
 * بازبینی GLM Audit 3 & 4 — منطق تجاری و سقف‌های طرح (فایل جدید؛ آزمون‌های موجود دست‌نخورده‌اند)
 *
 *  HX-01  سقف اعضای تیم: دعوت‌های باز صندلی رزرو می‌کنند + سقف هنگام پذیرش دعوت (دیوار آخر) + ارتقای مشتری به نقش تیمی
 *  HX-02  سقف ماهانه‌ی قرارداد: TOCTOU «بخوان‌-بعد-بنویس» در صدور/انتشار هم‌زمان (بدون کسر اعتبار)
 *  MX-02  اقساط: جایگزینی برنامه‌ی پرداخت هنگام وجود پرداخت در جریان (بیش از ۳۰ دقیقه) + قسط یتیم
 *  MX-03  سهمیه‌ی روزانه‌ی AI: رزرو اتمی پیش از تماس پرهزینه
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiGenerations, auditLogs, contractInstallments, contracts, payments, subscriptions, userNotifications, users, workspaceInvites, workspaceMembers } from "@/db/schema";
import { hashPassword, sha256 } from "@/lib/password";
import { createWorkspace, ensureClient } from "@/modules/tenancy/service";
import { acceptInvite, createInvite, createTeamInvite } from "@/modules/tenancy/invites";
import { acquireIssueQuota, assertCanAddMember, getUsage, pendingSeatEmails, PlanLimitError, withIssueQuota } from "@/modules/billing/service";
import { grantCredits, getWallet } from "@/modules/wallet/service";
import { issueContract, publishDraft } from "@/modules/contracts/service";
import { insertPlan, listInstallments, PayError, setPlan, startInstallmentPayment } from "@/modules/contract-pay/service";
import { announceInstallmentPaid } from "@/modules/contract-pay/service";
import { applyContractPayment, REFUND_ORPHAN } from "@/modules/contract-pay/fulfill";
import { buildSchedule, type PlanItem } from "@/modules/contract-pay/schedule";
import { generateWithAi, usageToday } from "@/modules/ai/service";
import { reserveAiQuota, settleAiQuota } from "@/modules/ai/quota";
import { saveSettings } from "@/modules/settings/service";
import { uniq } from "../helpers";

// تماس واقعی با سرویس AI ممنوع: شمارنده‌ی تماس‌ها «هزینه‌ی سوخته‌ی پلتفرم» را اندازه می‌گیرد
const aiCalls = vi.hoisted(() => ({ n: 0, delayMs: 40, fail: false }));
vi.mock("@/modules/ai/client", async (orig) => ({
  ...(await orig<typeof import("@/modules/ai/client")>()),
  aiChat: async () => {
    aiCalls.n++;
    await new Promise((r) => setTimeout(r, aiCalls.delayMs));
    if (aiCalls.fail) throw new Error("boom");
    return { text: "<h2>قرارداد آزمایشی</h2><p>این یک متن آزمایشی طولانی برای عبور از حداقل طول پاسخ معتبر مدل است و هیچ هزینه‌ای ندارد.</p>", tokens: 7 };
  },
}));

let seq = 0;
async function newOwner(label: string) {
  const [u] = await db
    .insert(users)
    .values({ name: label, email: `${uniq("hx")}@example.com`, mobile: `0912${String(3000000 + ++seq * 13)}`, passwordHash: hashPassword("Hx12345678x"), role: "user", emailVerifiedAt: new Date() })
    .returning();
  const ws = await createWorkspace(u.id, `فضای ${label}`);
  return { u, ws };
}
const upgrade = (ws: number, plan = "business") => db.insert(subscriptions).values({ workspaceId: ws, plan, currentPeriodEnd: new Date(Date.now() + 365 * 86400_000) }).onConflictDoUpdate({ target: subscriptions.workspaceId, set: { plan, currentPeriodEnd: new Date(Date.now() + 365 * 86400_000) } });
const teamMembers = async (ws: number) => (await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ws), sql`${workspaceMembers.role} <> 'client'`))).length;
const mkUser = async (email: string) => (await db.insert(users).values({ name: "عضو", email, mobile: `0912${String(4000000 + ++seq * 11)}`, passwordHash: hashPassword("Hx12345678x"), role: "user", emailVerifiedAt: new Date() }).returning())[0];
const settled = <T,>(ps: Promise<T>[]) => Promise.allSettled(ps);
const ok = (r: PromiseSettledResult<unknown>[]) => r.filter((x) => x.status === "fulfilled").length;
const limited = (r: PromiseSettledResult<unknown>[]) => r.filter((x) => x.status === "rejected" && (x.reason as Error) instanceof PlanLimitError).length;

/* ═════════════════════════ HX-01 ═════════════════════════ */
describe("HX-01 — سقف اعضای تیم (طرح رایگان: ۲ عضو؛ مالک خودش یکی است)", () => {
  it("دعوت‌های باز صندلی رزرو می‌کنند؛ دعوت دوم برای ایمیل دیگر رد، ارسال دوباره‌ی همان ایمیل مجاز", async () => {
    const { u, ws } = await newOwner("h1");
    const a = `${uniq("a")}@example.com`;
    await createTeamInvite(ws, a, "member", u.id);
    expect(await pendingSeatEmails(ws)).toEqual([a]);
    await expect(createTeamInvite(ws, `${uniq("b")}@example.com`, "member", u.id)).rejects.toBeInstanceOf(PlanLimitError);
    await expect(createTeamInvite(ws, a.toUpperCase(), "viewer", u.id)).resolves.toMatch(/^[a-f0-9]{64}$/); // لینک گم‌شده دوباره فرستاده می‌شود
    await expect(assertCanAddMember(ws)).rejects.toBeInstanceOf(PlanLimitError); // پیش‌سنجش هم دعوت‌های باز را می‌شمارد
    await expect(assertCanAddMember(ws, { email: a })).resolves.toBeUndefined();
    expect((await getUsage(ws)).members).toBe(1);
  });

  it("ساخت انبوه و هم‌زمانِ دعوت‌نامه: فقط به اندازه‌ی ظرفیت باقی‌مانده موفق می‌شود", async () => {
    const { u, ws } = await newOwner("h2");
    const res = await settled(Array.from({ length: 12 }, (_, i) => createTeamInvite(ws, `bulk${i}-${uniq("x")}@example.com`, "member", u.id)));
    expect(ok(res)).toBe(1);
    expect(limited(res)).toBe(11);
    expect(await db.select().from(workspaceInvites).where(eq(workspaceInvites.workspaceId, ws))).toHaveLength(1);
  });

  it("نقش client صندلی نمی‌گیرد و دعوت‌های client در شمارش نمی‌آیند", async () => {
    const { u, ws } = await newOwner("h3");
    await createTeamInvite(ws, `${uniq("c1")}@example.com`, "client", u.id);
    await createTeamInvite(ws, `${uniq("c2")}@example.com`, "client", u.id);
    await createTeamInvite(ws, `${uniq("m")}@example.com`, "member", u.id); // هنوز یک صندلی آزاد بود
    expect(await pendingSeatEmails(ws)).toHaveLength(1);
  });

  it("دعوت منقضی یا پذیرفته‌شده صندلی نگه نمی‌دارد", async () => {
    const { u, ws } = await newOwner("h4");
    const e1 = `${uniq("old")}@example.com`;
    await createTeamInvite(ws, e1, "member", u.id);
    await db.update(workspaceInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(workspaceInvites.workspaceId, ws));
    expect(await pendingSeatEmails(ws)).toEqual([]);
    await expect(createTeamInvite(ws, `${uniq("new")}@example.com`, "member", u.id)).resolves.toBeTruthy();
  });

  it("🛡️ دیوار آخر: پذیرش هم‌زمان دعوت‌های «قدیمی/بدون سنجش» هم از سقف رد نمی‌شود، و دعوت بازنده نمی‌سوزد", async () => {
    const { u, ws } = await newOwner("h5");
    // دعوت‌هایی که پیش از رفع یا با createInvite خام ساخته شده‌اند (نقطه‌ی ورود قدیمی)
    const people = await Promise.all(Array.from({ length: 4 }, async () => mkUser(`${uniq("late")}@example.com`)));
    const tokens = await Promise.all(people.map((p) => createInvite(ws, p.email, "member", u.id)));
    const res = await settled(people.map((p, i) => acceptInvite(tokens[i], p.id)));
    expect(ok(res)).toBe(1);
    expect(limited(res)).toBe(3);
    expect(await teamMembers(ws)).toBe(2); // مالک + یک نفر؛ نه ۵
    // دعوت‌های بازنده مصرف نشده‌اند و پس از ارتقای طرح هنوز کار می‌کنند
    const losers = people.map((p, i) => ({ p, t: tokens[i] })).filter((_, i) => res[i].status === "rejected");
    for (const l of losers) expect((await db.select().from(workspaceInvites).where(eq(workspaceInvites.tokenHash, sha256(l.t))))[0].acceptedAt).toBeNull();
    await upgrade(ws);
    for (const l of losers) expect(await acceptInvite(l.t, l.p.id)).toEqual({ workspaceId: ws });
    expect(await teamMembers(ws)).toBe(5);
  });

  it("پذیرش: عضو تیمیِ موجود و نقش client صندلی نمی‌خواهند؛ مشتری→تیم صندلی می‌خواهد", async () => {
    const { u, ws } = await newOwner("h6");
    const [m] = await Promise.all([mkUser(`${uniq("mem")}@example.com`)]);
    await db.insert(workspaceMembers).values({ workspaceId: ws, userId: m.id, role: "member" }); // ظرفیت پر (۲ از ۲)
    // عضو فعلی دوباره دعوت می‌شود: صندلی جدیدی نمی‌خواهد
    expect(await acceptInvite(await createInvite(ws, m.email, "viewer", u.id), m.id)).toEqual({ workspaceId: ws });
    // نقش client همیشه آزاد است
    const c = await mkUser(`${uniq("cli")}@example.com`);
    expect(await acceptInvite(await createInvite(ws, c.email, "client", u.id), c.id)).toEqual({ workspaceId: ws });
    // مشتریِ موجود با دعوت تیمی → ارتقا؛ ظرفیت پر است ⇒ رد
    await expect(acceptInvite(await createInvite(ws, c.email, "member", u.id), c.id)).rejects.toBeInstanceOf(PlanLimitError);
    expect((await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ws), eq(workspaceMembers.userId, c.id))))[0].role).toBe("client");
  });

  it("کاهش طرح پس از دعوت: اعضای موجود دست نمی‌خورند ولی عضو تازه نمی‌آید", async () => {
    const { u, ws } = await newOwner("h7");
    await upgrade(ws);
    const p = await mkUser(`${uniq("dg")}@example.com`);
    const t = await createTeamInvite(ws, p.email, "member", u.id);
    await db.delete(subscriptions).where(eq(subscriptions.workspaceId, ws)); // برگشت به رایگان
    const q = await mkUser(`${uniq("dg2")}@example.com`);
    await db.insert(workspaceMembers).values({ workspaceId: ws, userId: q.id, role: "member" });
    await expect(acceptInvite(t, p.id)).rejects.toBeInstanceOf(PlanLimitError);
    expect(await teamMembers(ws)).toBe(2);
  });
});

/* ═════════════════════════ HX-02 ═════════════════════════ */
describe("HX-02 — سقف ماهانه‌ی قرارداد در درخواست‌های موازی (طرح رایگان: ۱۰ قرارداد)", () => {
  async function seedPublished(ws: number, customerId: number, n: number) {
    for (let i = 0; i < n; i++) await db.insert(contracts).values({ workspaceId: ws, number: `HX-${ws}-${i}-${uniq("n")}`, title: "t", customerId, bodyHtml: "x", status: "sent", publishedAt: new Date() });
  }
  const insertOne = (ws: number, customerId: number) => async () => {
    await db.insert(contracts).values({ workspaceId: ws, number: `HXP-${ws}-${uniq("p")}`, title: "t", customerId, bodyHtml: "x", status: "sent", publishedAt: new Date() });
  };

  it("withIssueQuota: ۸ قرارداد موجود + ۶ درخواست هم‌زمان ⇒ فقط ۲ موفق (قبلاً هر ۶ موفق می‌شد)", async () => {
    const { u, ws } = await newOwner("q1");
    await seedPublished(ws, u.id, 8);
    const res = await settled(Array.from({ length: 6 }, () => withIssueQuota(ws, 1, {}, insertOne(ws, u.id))));
    expect(ok(res)).toBe(2);
    expect(limited(res)).toBe(4);
    expect((await getUsage(ws)).contracts).toBe(10);
  });

  it("اعتبار کیف پول دقیقاً یک‌بار به‌ازای هر قرارداد بالای سقف کسر می‌شود (نه صفر‌بار، نه بیشتر)", async () => {
    const { u, ws } = await newOwner("q2");
    await seedPublished(ws, u.id, 8);
    await grantCredits(ws, 3, { kind: "referral_reward", ref: `hx-${ws}`, description: "t" });
    const res = await settled(Array.from({ length: 9 }, () => withIssueQuota(ws, 1, {}, insertOne(ws, u.id))));
    expect(ok(res)).toBe(5); // ۲ داخل سقف + ۳ با اعتبار
    expect((await getWallet(ws)).credits).toBe(0);
    expect((await getUsage(ws)).contracts).toBe(13);
  });

  it("شکست عمل میانی ⇒ rollback کامل؛ اعتبار برمی‌گردد و جایی مصرف نمی‌شود", async () => {
    const { u, ws } = await newOwner("q3");
    await seedPublished(ws, u.id, 10);
    await grantCredits(ws, 1, { kind: "referral_reward", ref: `hx3-${ws}`, description: "t" });
    await expect(withIssueQuota(ws, 1, {}, async () => { throw new Error("fail-after-quota"); })).rejects.toThrow("fail-after-quota");
    expect((await getWallet(ws)).credits).toBe(1);
  });

  it("issueContract (مسیر واقعی): ۸ موجود + ۵ صدور هم‌زمان ⇒ فقط ۲ قرارداد ساخته می‌شود", async () => {
    const { u, ws } = await newOwner("q4");
    await seedPublished(ws, u.id, 8);
    const cust = await ensureClient(ws, { name: "مشتری", email: `${uniq("cu")}@example.com`, mobile: "09121234567" });
    const before = (await db.select().from(contracts).where(eq(contracts.workspaceId, ws))).length;
    const res = await settled(Array.from({ length: 5 }, (_, i) => issueContract({ workspaceId: ws, title: `هم‌زمان ${i}`, bodyHtml: "<p>متن آزمایشی قرارداد هم‌زمان برای آزمون سقف.</p>", customerId: cust.userId, createdBy: u.id })));
    expect(ok(res)).toBe(2);
    expect(limited(res)).toBe(3);
    expect((await db.select().from(contracts).where(eq(contracts.workspaceId, ws))).length).toBe(before + 2);
    expect((await getUsage(ws)).contracts).toBe(10);
  });

  it("publishDraft: انتشار هم‌زمان چند پیش‌نویس هم از سقف رد نمی‌شود", async () => {
    const { u, ws } = await newOwner("q5");
    await seedPublished(ws, u.id, 8);
    const cust = await ensureClient(ws, { name: "مشتری", email: `${uniq("cu")}@example.com`, mobile: "09121234568" });
    const drafts = await Promise.all(Array.from({ length: 5 }, (_, i) => issueContract({ workspaceId: ws, title: `پ${i}`, bodyHtml: "<p>متن پیش‌نویس آزمایشی برای انتشار هم‌زمان.</p>", customerId: cust.userId, createdBy: u.id, draft: true })));
    const res = await settled(drafts.map((id, i) => publishDraft(id, u.id, { title: `پ${i}`, bodyHtml: "<p>متن پیش‌نویس آزمایشی برای انتشار هم‌زمان.</p>" }, ws)));
    expect(ok(res)).toBe(2);
    expect((await getUsage(ws)).contracts).toBe(10);
  });

  it("publishDraft: انتشار هم‌زمانِ «یک» پیش‌نویس فقط یک‌بار اعتبار کسر می‌کند", async () => {
    const { u, ws } = await newOwner("q6");
    await seedPublished(ws, u.id, 10);
    await grantCredits(ws, 3, { kind: "referral_reward", ref: `hx6-${ws}`, description: "t" });
    const cust = await ensureClient(ws, { name: "مشتری", email: `${uniq("cu")}@example.com`, mobile: "09121234569" });
    const id = await issueContract({ workspaceId: ws, title: "یکتا", bodyHtml: "<p>پیش‌نویس یکتا برای انتشار دوباره‌ی هم‌زمان.</p>", customerId: cust.userId, createdBy: u.id, draft: true });
    const res = await settled(Array.from({ length: 4 }, () => publishDraft(id, u.id, { title: "یکتا", bodyHtml: "<p>پیش‌نویس یکتا برای انتشار دوباره‌ی هم‌زمان.</p>" }, ws)));
    expect(ok(res)).toBe(1);
    expect((await getWallet(ws)).credits).toBe(2);
  });

  it("acquireIssueQuota بیرون از تراکنش همان رفتار قبلی (سنجش لحظه‌ای) را دارد", async () => {
    const { u, ws } = await newOwner("q7");
    await seedPublished(ws, u.id, 10);
    await expect(acquireIssueQuota(ws)).rejects.toBeInstanceOf(PlanLimitError);
  });
});

/* ═════════════════════════ MX-03 ═════════════════════════ */
describe("MX-03 — سهمیه‌ی روزانه‌ی AI (طرح رایگان: ۸ در روز) با رزرو اتمی", () => {
  afterEach(() => {
    aiCalls.fail = false;
    aiCalls.delayMs = 40;
  });
  async function aiWorkspace(label: string) {
    const { u, ws } = await newOwner(label);
    await saveSettings({ ai_api_key: "sk-test-key-1234567890" }, ws);
    return { u, ws };
  }

  it("reserveAiQuota: ۳۰ رزرو هم‌زمان ⇒ دقیقاً به اندازه‌ی سقف موفق", async () => {
    const { u, ws } = await newOwner("a1");
    const rs = await Promise.all(Array.from({ length: 30 }, () => reserveAiQuota({ workspaceId: ws, userId: u.id, kind: "contract", prompt: "p", model: "m" })));
    expect(rs.filter((r) => r.ok)).toHaveLength(8);
    expect((await usageToday(ws)).used).toBe(8);
  });

  it("generateWithAi: ۲۰ درخواست موازی ⇒ فقط ۸ تماس واقعی با سرویس (هزینه‌ی پلتفرم سقف دارد) و باقی ۴۲۹", async () => {
    const { u, ws } = await aiWorkspace("a2");
    aiCalls.n = 0;
    aiCalls.delayMs = 120;
    const rs = await Promise.all(Array.from({ length: 20 }, () => generateWithAi({ workspaceId: ws, workspaceName: "ف", userId: u.id, mode: "generate", prompt: "قرارداد خدمات مشاوره‌ی یک ساله", length: "short" })));
    expect(aiCalls.n).toBe(8);
    expect(rs.filter((r) => r.ok)).toHaveLength(8);
    expect(rs.filter((r) => !r.ok && r.status === 429)).toHaveLength(12);
    expect((await usageToday(ws)).used).toBe(8);
    const rows = await db.select().from(aiGenerations).where(eq(aiGenerations.workspaceId, ws));
    expect(rows.filter((r) => r.status === "ok")).toHaveLength(8);
    expect(rows.some((r) => r.status === "reserved")).toBe(false); // همه‌ی رزروها تسویه شده‌اند
    expect(rows.every((r) => r.tokens === 7)).toBe(true);
  });

  it("خطای سرویس سهمیه‌ی کاربر را برمی‌گرداند؛ رزرو معلق نمی‌ماند", async () => {
    const { u, ws } = await aiWorkspace("a3");
    aiCalls.fail = true;
    const rs = await Promise.all(Array.from({ length: 5 }, () => generateWithAi({ workspaceId: ws, workspaceName: "ف", userId: u.id, mode: "generate", prompt: "قرارداد خدمات مشاوره‌ی یک ساله", length: "short" })));
    expect(rs.every((r) => !r.ok && r.status === 502)).toBe(true);
    expect((await usageToday(ws)).used).toBe(0);
    aiCalls.fail = false;
    const again = await generateWithAi({ workspaceId: ws, workspaceName: "ف", userId: u.id, mode: "generate", prompt: "قرارداد خدمات مشاوره‌ی یک ساله", length: "short" });
    expect(again.ok).toBe(true);
    expect((await usageToday(ws)).used).toBe(1);
  });

  it("رزرو «در جریان» در شمارش می‌آید (usageToday/getUsage) و تسویه idempotent است", async () => {
    const { u, ws } = await newOwner("a4");
    const r = await reserveAiQuota({ workspaceId: ws, userId: u.id, kind: "risk", prompt: "x", model: "m" });
    if (!r.ok) throw new Error("باید رزرو می‌شد");
    expect((await usageToday(ws)).used).toBe(1);
    expect((await getUsage(ws)).ai).toBe(1);
    await settleAiQuota(r.id, { status: "failed", error: "e" });
    await settleAiQuota(r.id, { status: "ok", tokens: 99 }); // دومی اثری ندارد
    expect((await usageToday(ws)).used).toBe(0);
    expect((await db.select().from(aiGenerations).where(eq(aiGenerations.id, r.id)))[0].tokens).toBe(0);
  });

  it("رزروِ ۲۴ ساعت‌گذشته دیگر شمرده نمی‌شود (پنجره‌ی غلتان)", async () => {
    const { u, ws } = await newOwner("a5");
    for (let i = 0; i < 8; i++) await db.insert(aiGenerations).values({ workspaceId: ws, userId: u.id, status: "ok", createdAt: new Date(Date.now() - 25 * 3600_000) });
    expect((await reserveAiQuota({ workspaceId: ws, userId: u.id, kind: "contract", prompt: "p", model: "m" })).ok).toBe(true);
  });
});

/* ═════════════════════════ MX-02 ═════════════════════════ */
describe("MX-02 — جایگزینی برنامه‌ی اقساط و پرداخت در جریان", () => {
  const items = (amount = 2_000_000): PlanItem[] => {
    const s = buildSchedule({ total: amount, depositPercent: 0, count: 2, intervalDays: 30, gateDeposit: false });
    if (!s.ok) throw new Error(s.error);
    return s.items;
  };
  async function contractWithPlan(label: string) {
    const { u, ws } = await newOwner(label);
    await upgrade(ws);
    const cust = await ensureClient(ws, { name: "مشتری", email: `${uniq("pc")}@example.com`, mobile: "09127654321" });
    const id = await issueContract({ workspaceId: ws, title: "قرارداد اقساطی", bodyHtml: "<p>قرارداد اقساطی آزمایشی برای آزمون پرداخت در جریان.</p>", customerId: cust.userId, createdBy: u.id, contractValue: 2_000_000, onCreated: (cid) => insertPlan(cid, ws, items()) });
    const rows = await listInstallments(id);
    return { u, ws, id, rows };
  }
  const addPayment = (ws: number, userId: number, installmentId: number, o: { status?: string; error?: string | null; ageMin?: number; fulfilled?: boolean } = {}) =>
    db
      .insert(payments)
      .values({ workspaceId: ws, userId, plan: `contract:${installmentId}`, months: 1, amount: 1_000_000, kind: "contract", gateway: "sandbox", authority: `sandbox:${uniq("au")}-${"x".repeat(12)}`, status: o.status ?? "pending", error: o.error ?? null, createdAt: new Date(Date.now() - (o.ageMin ?? 1) * 60_000), fulfilledAt: o.fulfilled ? new Date() : null })
      .returning();
  const replace = (c: { ws: number; id: number; u: { id: number } }) => setPlan({ contractId: c.id, workspaceId: c.ws, actorId: c.u.id, items: items(3_000_000) });

  it("پرداخت pending با سن ۴۵ دقیقه (فراتر از پنجره‌ی قدیمی ۳۰ دقیقه‌ای) هنوز جلوی جایگزینی را می‌گیرد", async () => {
    const c = await contractWithPlan("m1");
    await addPayment(c.ws, c.u.id, c.rows[0].id, { ageMin: 45 });
    await expect(replace(c)).rejects.toBeInstanceOf(PayError);
    expect((await listInstallments(c.id)).map((r) => r.id)).toEqual(c.rows.map((r) => r.id)); // برنامه دست‌نخورده
  });

  it("پرداخت verify_pending (پول احتمالاً کسرشده) تا ۴۸ ساعت مسدودکننده است و پیام تایید نهایی می‌دهد", async () => {
    const c = await contractWithPlan("m2");
    await addPayment(c.ws, c.u.id, c.rows[1].id, { ageMin: 10 * 60, error: "verify_pending: timeout" });
    await expect(replace(c)).rejects.toThrow(/تایید نهایی/);
  });

  it("paid ولی اعمال‌نشده (fulfilled_at خالی) مسدودکننده است", async () => {
    const c = await contractWithPlan("m3");
    await addPayment(c.ws, c.u.id, c.rows[0].id, { status: "paid", ageMin: 5000, fulfilled: false });
    await expect(replace(c)).rejects.toBeInstanceOf(PayError);
  });

  it("پرداخت رهاشده (pending بدون نشانه، قدیمی‌تر از نشست درگاه) و پرداخت‌های تمام‌شده مانع نیستند", async () => {
    const c = await contractWithPlan("m4");
    await addPayment(c.ws, c.u.id, c.rows[0].id, { ageMin: 3 * 60 });
    await addPayment(c.ws, c.u.id, c.rows[0].id, { status: "failed", ageMin: 1 });
    await addPayment(c.ws, c.u.id, c.rows[1].id, { status: "paid", ageMin: 1, fulfilled: true });
    // قسطِ پرداخت‌شده خودش مانع جایگزینی است (قانون قبلی)؛ پس آن را از ماجرا کنار می‌گذاریم
    await db.update(payments).set({ status: "failed" }).where(and(eq(payments.workspaceId, c.ws), eq(payments.status, "paid")));
    await expect(replace(c)).resolves.toBeUndefined();
    expect(await listInstallments(c.id)).toHaveLength(2);
  });

  it("🛡️ قسط یتیم: پرداختی که پس از جایگزینی تایید شود گم نمی‌شود؛ با refund_required ثبت، ممیزی و اعلان می‌شود", async () => {
    const c = await contractWithPlan("m5");
    const staleId = c.rows[0].id;
    const [pay] = await addPayment(c.ws, c.u.id, staleId, { ageMin: 3 * 60 }); // رهاشده ⇒ جایگزینی مجاز
    await replace(c);
    expect((await listInstallments(c.id)).some((r) => r.id === staleId)).toBe(false);
    // کاربر دیرهنگام در درگاه پرداخت می‌کند و تایید می‌رسد
    await db.update(payments).set({ status: "paid", paidAt: new Date(), refId: "REF-LATE" }).where(eq(payments.id, pay.id));
    const out = await db.transaction(async (tx) => applyContractPayment(tx, { ...pay, status: "paid" }, "REF-LATE"));
    expect(out).toEqual({ applied: true, installmentId: null });
    const [after] = await db.select().from(payments).where(eq(payments.id, pay.id));
    expect(after.error).toBe(REFUND_ORPHAN);
    expect(after.fulfilledAt).not.toBeNull();
    const msg = await announceInstallmentPaid(after, "REF-LATE");
    expect(msg).toMatch(/گزارش شد/);
    expect((await db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, c.ws), eq(auditLogs.action, "pay.refund_required")))).length).toBe(1);
    expect((await db.select().from(userNotifications).where(sql`${userNotifications.title} like 'پرداخت بدون قسط%'`)).length).toBeGreaterThan(0);
  });

  it("قسط هم‌زمان دستی‌پرداخت‌شده: پرداخت درگاه با refund_required (already_paid) علامت می‌خورد", async () => {
    const c = await contractWithPlan("m6");
    await db.update(contractInstallments).set({ status: "paid", method: "manual", paidAt: new Date() }).where(eq(contractInstallments.id, c.rows[0].id));
    const [pay] = await addPayment(c.ws, c.u.id, c.rows[0].id, { status: "paid", ageMin: 1 });
    const out = await db.transaction(async (tx) => applyContractPayment(tx, pay, "REF-DUP"));
    expect(out).toEqual({ applied: true, installmentId: c.rows[0].id });
    expect((await db.select().from(payments).where(eq(payments.id, pay.id)))[0].error).toBe("refund_required:already_paid");
  });

  it("🛡️ رقابت setPlan با شروع پرداخت: هرگز «پرداخت زنده برای قسط حذف‌شده» ساخته نمی‌شود", async () => {
    for (let round = 0; round < 6; round++) {
      const c = await contractWithPlan(`m7-${round}`);
      const code = c.rows[0].payCode;
      const oldIds = c.rows.map((r) => r.id);
      const [rep, pay] = await settled<unknown>([replace(c), startInstallmentPayment({ code, origin: "http://localhost:3000" })]);
      const live = await db
        .select()
        .from(payments)
        .where(and(eq(payments.workspaceId, c.ws), eq(payments.status, "pending"), inArray(payments.plan, oldIds.map((i) => `contract:${i}`))));
      const stillThere = (await listInstallments(c.id)).filter((r) => oldIds.includes(r.id)).length;
      // یا برنامه جایگزین شده و هیچ پرداخت زنده‌ای به قسط قدیمی نمانده، یا برنامه دست‌نخورده است
      if (rep.status === "fulfilled") {
        expect(stillThere).toBe(0);
        expect(live).toHaveLength(0);
        expect(pay.status).toBe("rejected");
      } else {
        expect(stillThere).toBe(oldIds.length);
      }
    }
  });
});

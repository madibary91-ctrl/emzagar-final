/**
 * GLM Audit 5 — باگ‌های اولویت متوسط (P-07 · P-08 · P-09 · P-11 · P-12 · R-01 · R-02 · R-03)
 *
 * هر بخش با «اندازه‌گیری واقعی» (شمارش کوئری‌های pg) یا با آزمون رفتاری، یا واقعیت ادعا و رفعش را قفل می‌کند،
 * یا دلیل نادرست‌بودن بخشی از ادعا را ثابت می‌کند. هیچ آزمون موجودی تغییر نکرده است.
 */
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiGenerations, backgroundJobs, contracts, messengerBots, messengerChats, payments, userNotifications, users, workspaceSettings } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { __resetShutdownForTests, runShutdown } from "@/lib/shutdown";
import { setCacheTtlOverride } from "@/lib/ttl-cache";
import { openAiReservationCount, reserveAiQuota, settleAiQuota } from "@/modules/ai/quota";
import { usageToday } from "@/modules/ai/service";
import { sendDueReminders } from "@/modules/automation/service";
import { createPlan, listAllPlans, updatePlan } from "@/modules/billing/catalog";
import { getConversation } from "@/modules/chat/service";
import { appendMessage } from "@/modules/chat/service/conversations";
import { eventStream, FULL_REFRESH_EVERY, type TickCtx } from "@/modules/chat/sse";
import { notifyUser, notifyUsers } from "@/modules/inbox/service";
import { enqueueJob, enqueueJobs, purgeFinishedJobs, setJobsPaused } from "@/modules/jobs/queue";
import { chatTargetsForUser, chatTargetsForUsers } from "@/modules/messengers/service";
import { claimForVerification, reconcilePendingPayments } from "@/modules/payments/service";
import { getAllSettings, getAllSettingsMany, saveSettings } from "@/modules/settings/service";
import { createWorkspace } from "@/modules/tenancy/service";
import { getOrCreateSigningLink } from "@/modules/signing/links";
import { createSession } from "@/modules/auth/session";
import { GET as bootstrap } from "@/app/api/chat/bootstrap/route";
import { POST as send } from "@/app/api/chat/send/route";
import { GET as stream } from "@/app/api/chat/stream/route";
import { POST as staffAct } from "@/app/api/chat/staff/act/route";
import { freshBrowser, uniq } from "../helpers";
import { newContract, setupWorkspace } from "../flows";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const BASE = "http://localhost:3000";
const post = (path: string, body: unknown) => new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string, init?: RequestInit) => new Request(`${BASE}${path}`, init);

/** شمارنده‌ی «همه‌ی» کوئری‌های pg (هم استخر هم تراکنش) */
function countQueries() {
  const spy = vi.spyOn(Client.prototype as unknown as { query: (...a: unknown[]) => unknown }, "query");
  return {
    get n() {
      return spy.mock.calls.length;
    },
    reset: () => spy.mockClear(),
    stop: () => spy.mockRestore(),
  };
}

let seq = 0;
async function newUser(label: string, mobile?: string) {
  const [u] = await db
    .insert(users)
    .values({ name: label, email: `${uniq("a5")}@example.com`, mobile: mobile ?? `0913${String(6000000 + ++seq * 13)}`, passwordHash: hashPassword("Audit5x12345"), role: "user", emailVerifiedAt: new Date() })
    .returning();
  return u;
}

afterEach(() => {
  setCacheTtlOverride(null);
  setJobsPaused(false);
  __resetShutdownForTests();
});

/* ═══════════════════════ P-11 — getAllSettings بدون کش ═══════════════════════ */
describe("P-11 — تنظیمات: کش کوتاه‌مدت با ابطال فوری (ادعا واقعی بود)", () => {
  it("بدون کش (پیش‌فرض آزمون) هر خواندن یک کوئری است؛ با کش ۱۰۰ خواندن = ۱ کوئری", async () => {
    const { wsId } = await setupWorkspace("کش تنظیمات");
    const q = countQueries();
    try {
      await getAllSettings(wsId);
      await getAllSettings(wsId);
      expect(q.n).toBe(2); // رفتار قبلی/آزمون: همیشه تازه
      setCacheTtlOverride(60_000);
      q.reset();
      await Promise.all(Array.from({ length: 100 }, () => getAllSettings(wsId))); // هجوم هم‌زمان: single-flight
      for (let i = 0; i < 50; i++) await getAllSettings(wsId);
      expect(q.n).toBe(1);
    } finally {
      q.stop();
    }
  });

  it("ذخیره‌ی تنظیمات کش را فوراً باطل می‌کند؛ تغییر مستقیم دیتابیس تا ابطال دیده نمی‌شود (اثبات کش‌بودن)", async () => {
    const { wsId } = await setupWorkspace("ابطال تنظیمات");
    setCacheTtlOverride(60_000);
    const initial = (await getAllSettings(wsId)).site_name;
    expect(initial.length).toBeGreaterThan(0);
    await saveSettings({ site_name: "نام نو" }, wsId);
    expect((await getAllSettings(wsId)).site_name).toBe("نام نو"); // بدون انتظار TTL
    // نوشتن بیرون از سرویس (شبیه پروسه‌ی دیگر) تا TTL دیده نمی‌شود، سپس دیده می‌شود
    await db.update(workspaceSettings).set({ value: "نام پروسه‌ی دیگر" }).where(and(eq(workspaceSettings.workspaceId, wsId), eq(workspaceSettings.key, "site_name")));
    expect((await getAllSettings(wsId)).site_name).toBe("نام نو");
    setCacheTtlOverride(60_000); // پاک‌سازی کش (معادل گذشتن TTL)
    expect((await getAllSettings(wsId)).site_name).toBe("نام پروسه‌ی دیگر");
  });

  it("به فراخواننده «کپی» برمی‌گردد (دست‌کاری نتیجه کش را آلوده نمی‌کند) و کلید محرمانه رمزگشایی می‌شود", async () => {
    const { wsId } = await setupWorkspace("کپی تنظیمات");
    setCacheTtlOverride(60_000);
    await saveSettings({ smtp_pass: "راز-۱۲۳" }, wsId);
    const a = await getAllSettings(wsId);
    expect(a.smtp_pass).toBe("راز-۱۲۳");
    a.smtp_pass = "تخریب";
    a.site_name = "تخریب";
    const b = await getAllSettings(wsId);
    expect(b.smtp_pass).toBe("راز-۱۲۳");
    expect(b.site_name).toBe("کپی تنظیمات");
    // ردیف خام در دیتابیس همچنان رمزنگاری‌شده است
    const [row] = await db.select().from(workspaceSettings).where(and(eq(workspaceSettings.workspaceId, wsId), eq(workspaceSettings.key, "smtp_pass")));
    expect(row.value).not.toContain("راز");
  });

  it("getAllSettingsMany: N فضا با یک کوئری؛ دور دوم از کش (صفر کوئری)؛ نتیجه برابر getAllSettings", async () => {
    const { owner } = await setupWorkspace("چندفضایی");
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) {
      const id = await createWorkspace(owner.id, `فضا ${i}`);
      if (i % 2 === 0) await saveSettings({ reminder_max: String(i + 1) }, id);
      ids.push(id);
    }
    setCacheTtlOverride(60_000);
    const q = countQueries();
    try {
      const many = await getAllSettingsMany(ids);
      expect(q.n).toBe(1);
      q.reset();
      await getAllSettingsMany(ids);
      expect(q.n).toBe(0);
      for (const id of ids) expect(many.get(id)).toEqual(await getAllSettings(id));
      expect(many.get(ids[2])!.reminder_max).toBe("3");
      expect(many.get(ids[1])!.reminder_max).toBe("3"); // پیش‌فرض
    } finally {
      q.stop();
    }
  });
});

/* ═══════════════════════ P-12 — force-dynamic و داده‌ی بی‌کش ═══════════════════════ */
describe("P-12 — صفحه‌ها force-dynamic می‌مانند (عمدی)؛ داده‌ی عمومیِ بی‌کش کش شد", () => {
  it("کاتالوگ طرح‌ها (هر صفحه‌ی عمومی و هر getPlan): کش + ابطال هنگام ویرایش مدیر کل", async () => {
    setCacheTtlOverride(60_000);
    const q = countQueries();
    try {
      await listAllPlans();
      q.reset();
      for (let i = 0; i < 30; i++) await listAllPlans();
      expect(q.n).toBe(0);
    } finally {
      q.stop();
    }
    const id = uniq("p5").toLowerCase();
    const base = (await listAllPlans()).find((p) => !p.isDefault && p.isActive)!;
    const { id: _ignore, isDefault: _d, ...input } = base;
    void _ignore;
    void _d;
    const created = await createPlan({ ...input, highlight: !!input.highlight, id, name: "طرح پنج", priceToman: 111_000, isRewardPlan: false, isPublic: true });
    expect(created.ok).toBe(true);
    expect((await listAllPlans()).find((p) => p.id === id)?.priceToman).toBe(111_000); // بدون انتظار TTL
    await updatePlan(id, { ...input, highlight: !!input.highlight, id, name: "طرح پنج", priceToman: 222_000, isRewardPlan: false, isPublic: true });
    expect((await listAllPlans()).find((p) => p.id === id)?.priceToman).toBe(222_000);
    // نتیجه کپی است: دست‌کاری فهرست کش را خراب نمی‌کند
    (await listAllPlans()).length = 0;
    expect((await listAllPlans()).length).toBeGreaterThan(0);
  });

  it("دلیل force-dynamic: CSP با nonce هر درخواست — صفحه‌ی ایستا اسکریپت‌هایش را بی‌nonce می‌فرستد و مرورگر مسدود می‌کند", async () => {
    const fs = await import("node:fs");
    const csp = fs.readFileSync("src/lib/csp.ts", "utf8");
    expect(csp).toContain("'nonce-${nonce}'");
    expect(csp).toContain("'strict-dynamic'");
    const layout = fs.readFileSync("src/app/layout.tsx", "utf8");
    expect(layout).toContain('export const dynamic = "force-dynamic"');
    // و صفحه‌ی فرود شخصی‌سازی‌شده است (پیوند «ورود/پنل» بسته به نشست)، پس کش HTML کامل درست نیست
    const home = fs.readFileSync("src/app/page.tsx", "utf8");
    expect(home).toContain("getCurrentUser()");
  });
});

/* ═══════════════════════ P-08 — N+1 در notifyUsers ═══════════════════════ */
describe("P-08 — notifyUsers: درج دسته‌ای و هدف‌یابی دسته‌ای (N+1 دیتابیسی واقعی؛ «تماس زنجیره‌ای با پیام‌رسان» نادرست)", () => {
  let botId = 0;
  const people: (typeof users.$inferSelect)[] = [];
  beforeAll(async () => {
    const [bot] = await db
      .insert(messengerBots)
      .values({ provider: "bale", tokenEnc: "x", tokenHash: uniq("th"), webhookSecret: uniq("ws"), active: true })
      .returning();
    botId = bot.id;
    for (let i = 0; i < 30; i++) {
      const u = await newUser(`گیرنده ${i}`);
      people.push(u);
      // ۲۰ نفر با چت وصل‌شده؛ ۵ نفر چت بی‌صدا؛ ۵ نفر بدون چت
      if (i < 20) await db.insert(messengerChats).values({ botId, chatId: uniq("c"), userId: u.id, linkedAt: new Date() });
      else if (i < 25) await db.insert(messengerChats).values({ botId, chatId: uniq("m"), userId: u.id, linkedAt: new Date(), muted: true });
    }
    // یک چت با موبایل گواهی‌شده‌ی یکی از کاربران بدون چت وصل‌شده (مسیر verifiedMobile)
    await db.insert(messengerChats).values({ botId, chatId: uniq("v"), verifiedMobile: people[27].mobile, linkedAt: new Date() });
  });

  afterAll(async () => {
    // کارهای صف‌شده‌ی این بخش نباید بعداً توسط کارگر inline آزمون‌های دیگر (با تماس شبکه‌ای واقعی به بله) اجرا شوند
    await db.delete(backgroundJobs).where(inArray(backgroundJobs.type, ["messenger.notice", "a5.type"]));
    await db.update(messengerBots).set({ active: false }).where(eq(messengerBots.id, botId));
  });

  it("ادعای «تماس با پیام‌رسان»: هیچ تماس شبکه‌ای نیست؛ فقط ردیف صف درج می‌شود (الگوی Outbox)", async () => {
    const src = (await import("node:fs")).readFileSync("src/modules/messengers/outbox.ts", "utf8");
    expect(src).not.toMatch(/fetch\(|deliver\(|sendMessage/);
    expect(src).toContain("enqueueJob");
  });

  it("chatTargetsForUsers دقیقاً با chatTargetsForUser به‌ازای هر کاربر برابر است (از جمله مسیر موبایل گواهی‌شده و حالت verified)", async () => {
    const ids = people.map((p) => p.id);
    for (const mode of ["any", "verified"] as const) {
      const batch = await chatTargetsForUsers(ids, { mode });
      for (const id of ids) {
        const single = (await chatTargetsForUser(id, { mode })).map((t) => t.chat.id).sort();
        expect((batch.get(id) ?? []).map((t) => t.chat.id).sort()).toEqual(single);
      }
    }
    expect((await chatTargetsForUsers([people[27].id])).get(people[27].id)).toHaveLength(1);
    expect((await chatTargetsForUsers([people[29].id])).get(people[29].id)).toEqual([]);
    expect((await chatTargetsForUsers([])).size).toBe(0);
    expect((await chatTargetsForUsers([999999999])).get(999999999)).toEqual([]);
  });

  it("۳۰ گیرنده: تعداد کوئری ثابت (≤ ۸) و نه ≥ ۹۰؛ نتیجه‌ی کاربردی مثل قبل", async () => {
    setJobsPaused(true); // کارگر inline آزمون اجرا نکند؛ فقط درج صف را می‌سنجیم
    const key = uniq("batch:");
    const q = countQueries();
    let inserted = 0;
    try {
      inserted = await notifyUsers(people.map((p) => p.id), { title: "اعلان گروهی", body: "متن", dedupeKey: key });
      expect(q.n).toBeLessThanOrEqual(8);
    } finally {
      q.stop();
    }
    expect(inserted).toBe(30);
    const notes = await db.select().from(userNotifications).where(eq(userNotifications.dedupeKey, key));
    expect(notes).toHaveLength(30);
    const jobs = await db.select().from(backgroundJobs).where(and(eq(backgroundJobs.type, "messenger.notice"), like(backgroundJobs.dedupeKey, "mn:%")));
    const mine = jobs.filter((j) => notes.some((n) => j.dedupeKey?.startsWith(`mn:${n.id}:`)));
    // ۲۰ چت وصل‌شده + ۱ چت موبایل گواهی‌شده؛ ۵ چت بی‌صدا رد می‌شود
    expect(mine).toHaveLength(21);
    // اجرای دوباره با همان dedupeKey: هیچ اعلان یا کاری تکراری نیست
    expect(await notifyUsers(people.map((p) => p.id), { title: "اعلان گروهی", body: "متن", dedupeKey: key })).toBe(0);
    expect((await db.select().from(userNotifications).where(eq(userNotifications.dedupeKey, key))).length).toBe(30);
  });

  it("تکراری‌ها و null حذف می‌شوند؛ تک‌گیرنده همان مسیر notifyUser؛ skipMessenger صف نمی‌سازد", async () => {
    setJobsPaused(true);
    const before = (await db.select().from(backgroundJobs).where(eq(backgroundJobs.type, "messenger.notice"))).length;
    expect(await notifyUsers([null, undefined, people[0].id, people[0].id, people[1].id], { title: "x", skipMessenger: true })).toBe(2);
    expect((await db.select().from(backgroundJobs).where(eq(backgroundJobs.type, "messenger.notice"))).length).toBe(before);
    expect(await notifyUsers([people[2].id, people[2].id], { title: "تک" })).toBe(1);
    expect(await notifyUsers([], { title: "هیچ" })).toBe(0);
    expect(await notifyUser(people[3].id, { title: "تکی" })).toBe(true);
  });

  it("enqueueJobs: کلید تکراری داخل دسته یکی می‌شود؛ کار dead احیا می‌شود؛ کار زنده/تمام‌شده دست‌نخورده", async () => {
    setJobsPaused(true);
    const k = (s: string) => uniq(`ej-${s}-`);
    const [dead, live, fresh] = [k("dead"), k("live"), k("fresh")];
    await enqueueJob("a5.type", { v: 1 }, { dedupeKey: dead, kick: false });
    await enqueueJob("a5.type", { v: 1 }, { dedupeKey: live, kick: false });
    await db.update(backgroundJobs).set({ status: "dead", finishedAt: new Date(), attempts: 6 }).where(eq(backgroundJobs.dedupeKey, dead));
    const n = await enqueueJobs([
      { type: "a5.type", payload: { v: 2 }, dedupeKey: dead },
      { type: "a5.type", payload: { v: 2 }, dedupeKey: live },
      { type: "a5.type", payload: { v: 2 }, dedupeKey: fresh },
      { type: "a5.type", payload: { v: 2 }, dedupeKey: fresh },
      { type: "a5.type", payload: { v: 3 } },
    ]);
    expect(n).toBe(4);
    const get1 = async (key: string) => (await db.select().from(backgroundJobs).where(eq(backgroundJobs.dedupeKey, key)))[0];
    expect((await get1(dead)).status).toBe("pending");
    expect((await get1(dead)).attempts).toBe(0);
    expect((await get1(dead)).payload).toContain('"v":2');
    expect((await get1(live)).payload).toContain('"v":1'); // زنده: نادیده
    expect((await get1(fresh)).payload).toContain('"v":2');
    expect(await enqueueJobs([])).toBe(0);
  });
});

/* ═══════════════════════ P-09 — اتوماسیون روی همه‌ی فضاهای کاری ═══════════════════════ */
describe("P-09 — زمان‌بند یادآوری: هزینه به تعداد فضاهای «دارای قرارداد منتظر» وابسته است نه کل فضاها", () => {
  it("۴۰ فضای بی‌قرارداد + یک فضای دارای قرارداد: یادآوری ارسال می‌شود و کوئری‌ها ثابت (≤ ۸ برای فضاهای بی‌کار)", async () => {
    const ws = await setupWorkspace("یادآوری");
    for (let i = 0; i < 40; i++) await createWorkspace(ws.owner.id, `خالی ${i}`);
    const c = await newContract(ws.wsId, ws.owner.id, { title: "قرارداد منتظر" });
    await db.update(contracts).set({ issuedAt: new Date(Date.now() - 3 * 86400_000) }).where(eq(contracts.id, c.id));
    const sentNow = await sendDueReminders();
    expect(sentNow).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(contracts).where(eq(contracts.id, c.id));
    expect(row.reminderCount).toBe(1);
    // دور بعد: فاصله‌ی یادآوری نرسیده؛ هیچ ارسالی نیست و هزینه مستقل از ۴۰ فضای خالی است
    const q = countQueries();
    try {
      expect(await sendDueReminders()).toBe(0);
      expect(q.n).toBeLessThanOrEqual(8); // قبلاً ≥ ۲×۴۱
    } finally {
      q.stop();
    }
  });

  it("فضای بدون قرارداد قدیمی یا سقف یادآوری‌شده کاوش نمی‌شود؛ یادآوری فضایی که تنظیمش خاموش است ارسال نمی‌شود", async () => {
    const ws = await setupWorkspace("یادآوری خاموش");
    await saveSettings({ reminder_enabled: "0" }, ws.wsId);
    const c = await newContract(ws.wsId, ws.owner.id, { title: "خاموش" });
    await db.update(contracts).set({ issuedAt: new Date(Date.now() - 5 * 86400_000) }).where(eq(contracts.id, c.id));
    await sendDueReminders();
    expect((await db.select().from(contracts).where(eq(contracts.id, c.id)))[0].reminderCount).toBe(0);
  });
});

/* ═══════════════════════ P-07 — SSE گفتگو ═══════════════════════ */
describe("P-07 — SSE گفتگو: poll تطبیقی + کش مشترک + خواندن پیام فقط هنگام تغییر", () => {
  const readers: { ac: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> }[] = [];
  afterEach(async () => {
    for (const r of readers.splice(0)) {
      r.ac.abort();
      await r.reader.cancel().catch(() => undefined);
    }
  });

  function open(signal: AbortSignal, handler: (req: Request) => Promise<Response>, url: string) {
    return handler(get(url, { signal }));
  }

  it("eventStream: ctx درست (connect/wake/poll)، full هر ۶ poll، و poll بی‌تغییر آرام‌آرام کندتر می‌شود اما wake فوری است", async () => {
    const ac = new AbortController();
    const calls: { at: number; ctx: TickCtx }[] = [];
    const t0 = Date.now();
    let changeAtPoll = -1;
    const res = eventStream(new Request(`${BASE}/x`, { signal: ac.signal }), {
      wake: "a5-wake-code",
      intervalMs: 40,
      idleMaxMs: 160,
      maxMs: 5000,
      run: async (emit, ctx) => {
        calls.push({ at: Date.now() - t0, ctx });
        if (ctx.reason === "poll" && ctx.n === changeAtPoll) emit("x", { n: ctx.n });
      },
    });
    const reader = res.body!.getReader();
    void (async () => {
      for (;;) if ((await reader.read()).done) return;
    })();
    await sleep(1200);
    const idlePolls = calls.filter((c) => c.ctx.reason === "poll");
    expect(calls[0].ctx.reason).toBe("connect");
    // ثابت ۴۰ms ⇒ ≈۳۰ poll؛ تطبیقی تا سقف ۱۶۰ms ⇒ بسیار کمتر
    expect(idlePolls.length).toBeLessThan(16);
    expect(idlePolls.length).toBeGreaterThan(5);
    expect(idlePolls.filter((c) => c.ctx.full).every((c) => c.ctx.n % FULL_REFRESH_EVERY === 0)).toBe(true);
    expect(idlePolls.some((c) => c.ctx.full)).toBe(true);
    // فاصله‌ها به سقف می‌رسند و از آن بیشتر نمی‌شوند
    const gaps = idlePolls.slice(1).map((c, i) => c.at - idlePolls[i].at);
    expect(Math.max(...gaps)).toBeLessThan(160 + 120);
    expect(gaps.at(-1)!).toBeGreaterThan(120);
    // بیدارباش: فوری و با reason=wake
    const { chatWake } = await import("@/modules/chat/bus");
    const n0 = calls.length;
    chatWake("a5-wake-code");
    await sleep(30);
    expect(calls.length).toBe(n0 + 1);
    expect(calls.at(-1)!.ctx.reason).toBe("wake");
    // رویداد: فاصله‌ی poll به پایه برمی‌گردد
    changeAtPoll = (calls.filter((c) => c.ctx.reason === "poll").at(-1)?.ctx.n ?? 0) + 1;
    await sleep(500);
    ac.abort();
    await reader.cancel().catch(() => undefined);
  });

  describe("روی مسیر واقعی /api/chat/stream", () => {
    let wsx: Awaited<ReturnType<typeof setupWorkspace>>;
    let code = "";
    let cookie = "";
    const env = () => (globalThis as unknown as { __testEnv: { cookies: Map<string, string> } }).__testEnv;

    beforeAll(async () => {
      wsx = await setupWorkspace("تیم SSE");
      const c = await newContract(wsx.wsId, wsx.owner.id, { title: "قرارداد SSE" });
      const token = (await getOrCreateSigningLink(c.signers[0].id))!.token;
      freshBrowser();
      await bootstrap(get(`/api/chat/bootstrap?kind=sign&ref=${token}`));
      const r = await send(post("/api/chat/send", { kind: "sign", ref: token, text: "سلام SSE", clientId: "sse-1", path: "/sign/x" }));
      code = ((await r.json()) as { conversation: { code: string } }).conversation.code;
      cookie = env().cookies.get("amz_chat") ?? "";
      expect(cookie.length).toBeGreaterThan(30);
    });

    async function connect(after = 0) {
      freshBrowser();
      env().cookies.set("amz_chat", cookie);
      const ac = new AbortController();
      const res = await open(ac.signal, stream, `/api/chat/stream?c=${code}&after=${after}`);
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      const box = { buf: "" };
      readers.push({ ac, reader });
      void (async () => {
        for (;;) {
          const r = await reader.read().catch(() => ({ done: true, value: undefined }));
          if (r.done) return;
          box.buf += dec.decode(r.value);
        }
      })();
      return box;
    }
    const until = async (box: { buf: string }, needle: string, ms = 9000) => {
      const t0 = Date.now();
      while (!box.buf.includes(needle) && Date.now() - t0 < ms) await sleep(40);
      return box.buf.includes(needle);
    };

    it("۲۰ اتصال هم‌زمان به یک گفتگو: کوئری‌های حالت پایدار چند برابر کمتر از ۲۰×poll×۳ (اندازه‌گیری واقعی)", async () => {
      setCacheTtlOverride(1000);
      const boxes = [];
      for (let i = 0; i < 20; i++) boxes.push(await connect());
      for (const b of boxes) expect(await until(b, "event: state")).toBe(true);
      await sleep(300);
      const q = countQueries();
      try {
        await sleep(6500); // ≈ ۲ تا ۳ poll برای هر اتصال
        // قبلاً: ۲۰ اتصال × ≥۲ poll × ≥۳ کوئری ≥ ۱۲۰؛ اکنون فقط خواندن‌های مشترکِ کش‌شده + ضربان حضور (۲۰ثانیه‌ای)
        expect(q.n).toBeLessThan(40);
      } finally {
        q.stop();
      }
    });

    it("پیام تازه‌ی همین پروسه با کش روشن فوراً می‌رسد (ابطال کش با chatWake)", async () => {
      setCacheTtlOverride(2500);
      const box = await connect();
      expect(await until(box, "event: state")).toBe(true);
      const owner = wsx.owner;
      freshBrowser();
      await createSession(owner.id, owner.passwordHash);
      const t0 = Date.now();
      await staffAct(post("/api/chat/staff/act", { queue: "workspace", code, action: "send", text: "پاسخ فوری ۱", clientId: "sse-s1" }));
      expect(await until(box, "پاسخ فوری ۱", 2000)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(2000);
    });

    it("نوشتن «پروسه‌ی دیگر» (بدون بیدارباش این پروسه) با poll دیده می‌شود و گم نمی‌شود", async () => {
      setCacheTtlOverride(1000);
      const box = await connect();
      expect(await until(box, "event: state")).toBe(true);
      const g = globalThis as typeof globalThis & { __emzChatBus?: import("node:events").EventEmitter };
      const real = g.__emzChatBus;
      const conv = (await getConversation(code))!;
      const { EventEmitter } = await import("node:events");
      g.__emzChatBus = new EventEmitter(); // شبیه‌سازی: اتصال‌های این پروسه بیدار نمی‌شوند
      try {
        await appendMessage(conv, { kind: "staff", userId: wsx.owner.id, name: "پشتیبان", body: "پیام از نمونه‌ی دیگر" });
      } finally {
        g.__emzChatBus = real;
      }
      expect(await until(box, "پیام از نمونه‌ی دیگر", 9000)).toBe(true);
    });
  });
});

/* ═══════════════════════ R-01 — کارهای مرده ═══════════════════════ */
describe("R-01 — کارهای dead قدیمی هم واقعاً پاک می‌شوند و کلید dedupe را اشغال نمی‌کنند", () => {
  const key = (s: string) => uniq(`pf-${s}-`);
  const put = async (k: string, status: string, ageDays: number, opts: { noFinished?: boolean } = {}) => {
    await enqueueJob("a5.purge", {}, { dedupeKey: k, kick: false });
    const at = new Date(Date.now() - ageDays * 86400_000);
    await db
      .update(backgroundJobs)
      .set({ status, createdAt: at, finishedAt: opts.noFinished || status === "pending" || status === "running" ? null : at })
      .where(eq(backgroundJobs.dedupeKey, k));
  };
  const exists = async (k: string) => (await db.select().from(backgroundJobs).where(eq(backgroundJobs.dedupeKey, k))).length === 1;

  it("done>۷ روز و dead>۳۰ روز (حتی بدون finished_at) پاک؛ تازه‌ها و pending/running هرگز", async () => {
    const k = { doneOld: key("do"), doneNew: key("dn"), deadOld: key("xo"), deadNull: key("xn"), deadNew: key("xw"), pendOld: key("po"), runOld: key("ro") };
    await put(k.doneOld, "done", 8);
    await put(k.doneNew, "done", 1);
    await put(k.deadOld, "dead", 31);
    await put(k.deadNull, "dead", 40, { noFinished: true }); // رکورد قدیمیِ بدون finished_at: NULL < x هرگز درست نمی‌شد
    await put(k.deadNew, "dead", 5);
    await put(k.pendOld, "pending", 90);
    await put(k.runOld, "running", 90);
    const r = await purgeFinishedJobs();
    expect(r.done).toBeGreaterThanOrEqual(1);
    expect(r.dead).toBeGreaterThanOrEqual(2);
    expect(await exists(k.doneOld)).toBe(false);
    expect(await exists(k.deadOld)).toBe(false);
    expect(await exists(k.deadNull)).toBe(false);
    expect(await exists(k.doneNew)).toBe(true);
    expect(await exists(k.deadNew)).toBe(true);
    expect(await exists(k.pendOld)).toBe(true);
    expect(await exists(k.runOld)).toBe(true);
  });

  it("دسته‌ای: با batch=۲ چندین دور حذف می‌کند تا همه پاک شوند و به maxBatches احترام می‌گذارد", async () => {
    const ks = Array.from({ length: 7 }, (_, i) => key(`b${i}`));
    for (const k of ks) await put(k, "dead", 45);
    const first = await purgeFinishedJobs({ batch: 2, maxBatches: 1 });
    expect(first.dead).toBe(2);
    await purgeFinishedJobs({ batch: 2 });
    for (const k of ks) expect(await exists(k)).toBe(false);
  });

  it("dead (قدیمی یا تازه) با درج دوباره‌ی همان کلید احیا می‌شود (مستقل از پاک‌سازی)", async () => {
    const k = key("rev");
    await put(k, "dead", 3);
    await enqueueJob("a5.purge", { again: true }, { dedupeKey: k, kick: false });
    const [row] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.dedupeKey, k));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
  });
});

/* ═══════════════════════ R-02 — SIGTERM و رزروهای AI ═══════════════════════ */
describe("R-02 — خاموشی: چند رزرو باز همگی آزاد می‌شوند و تسویه‌ی دیرهنگام رزرو را زنده نمی‌کند", () => {
  it("۳ رزرو هم‌زمان باز → پس از SIGTERM همه failed و سهمیه برگشته؛ settle دیرهنگام بی‌اثر", async () => {
    const owner = await setupWorkspace("خاموشی AI");
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await reserveAiQuota({ workspaceId: owner.wsId, userId: owner.owner.id, kind: "contract", prompt: "p", model: "m" });
      expect(r.ok).toBe(true);
      ids.push((r as { id: number }).id);
    }
    expect((await usageToday(owner.wsId)).used).toBe(3);
    await runShutdown("SIGTERM(a5)", { graceMs: 1000 });
    expect(openAiReservationCount()).toBe(0);
    expect((await usageToday(owner.wsId)).used).toBe(0);
    const rows = await db.select().from(aiGenerations).where(inArray(aiGenerations.id, ids));
    expect(rows.every((r) => r.status === "failed" && (r.error ?? "").includes("shutdown"))).toBe(true);
    // تماسِ دیرهنگام که بعد از آزادسازی تمام می‌شود، ردیف را دوباره «ok» نمی‌کند (سهمیه دوبار حساب نمی‌شود)
    await settleAiQuota(ids[0], { status: "ok", tokens: 99 });
    const [after] = await db.select().from(aiGenerations).where(eq(aiGenerations.id, ids[0]));
    expect(after.status).toBe("failed");
    expect((await usageToday(owner.wsId)).used).toBe(0);
  });
});

/* ═══════════════════════ R-03 — شکاف پول (بازبینی منصفانه با درگاه) ═══════════════════════ */
describe("R-03 — بازبینی پرداخت‌های نیمه‌کاره: نوبت منصفانه، افق ۳۰ روزه، برداشت اتمی", () => {
  let owner: Awaited<ReturnType<typeof setupWorkspace>>;
  let n = 0;
  const MIN = 60_000;
  beforeAll(async () => {
    owner = await setupWorkspace("بازبینی پول");
  });
  const mk = async (o: { ageMs: number; error?: string | null; checkedAgoMs?: number; gateway?: string; authority?: string; status?: string }) => {
    const authority = o.authority ?? `A5${String(Date.now()).slice(-8)}${String(++n).padStart(6, "0")}`;
    const [row] = await db
      .insert(payments)
      .values({
        workspaceId: owner.wsId,
        userId: owner.owner.id,
        plan: "pro",
        amount: 1000,
        gateway: o.gateway ?? "zarinpal",
        authority,
        status: o.status ?? "pending",
        error: o.error ?? null,
        createdAt: new Date(Date.now() - o.ageMs),
        verifyCheckedAt: o.checkedAgoMs === undefined ? null : new Date(Date.now() - o.checkedAgoMs),
      })
      .returning();
    return row;
  };
  const clean = () => db.update(payments).set({ status: "failed" }).where(eq(payments.status, "pending"));

  it("round-robin: ۳۰ تراکنش رهاشده با limit=۱۰ در سه دور بدون تکرار پوشش داده می‌شوند و تراکنش تازه‌ی برنگشته جلوی ردیف‌های قدیمی می‌ایستد (قبلاً گرسنگی)", async () => {
    await clean();
    const old = [];
    for (let i = 0; i < 30; i++) old.push((await mk({ ageMs: 90 * MIN + i * MIN })).authority);
    const a = (await claimForVerification(10)).map((r) => r.authority);
    const b = (await claimForVerification(10)).map((r) => r.authority);
    const c = (await claimForVerification(10)).map((r) => r.authority);
    expect(new Set([...a, ...b, ...c]).size).toBe(30);
    expect(new Set([...a, ...b, ...c])).toEqual(new Set(old));
    // پرداختِ تازه (۱۱ دقیقه‌ی پیش) که واقعاً پول گرفته: اکنون پیش از هر ردیفی که تازه بازبینی شده برداشته می‌شود
    const fresh = await mk({ ageMs: 11 * MIN });
    const next = await claimForVerification(1);
    expect(next.map((r) => r.authority)).toEqual([fresh.authority]);
    await clean();
  });

  it("افق: verify_pending قدیمی‌تر از ۴۸ ساعت دیگر رها نمی‌شود (روزانه) تا ۳۰ روز؛ سپس stale گزارش می‌شود", async () => {
    await clean();
    const H = 3600_000;
    const P = "verify_pending: gateway down";
    const due = await mk({ ageMs: 3 * 24 * H, error: P }); // هرگز بازبینی نشده
    const dueDaily = await mk({ ageMs: 10 * 24 * H, error: P, checkedAgoMs: 25 * H });
    const notYet = await mk({ ageMs: 10 * 24 * H, error: P, checkedAgoMs: 2 * H });
    const hourly = await mk({ ageMs: 5 * H, error: P, checkedAgoMs: 61 * MIN });
    const tooSoon = await mk({ ageMs: 5 * H, error: P, checkedAgoMs: 10 * MIN });
    const young = await mk({ ageMs: 20 * MIN, error: P, checkedAgoMs: 1 * MIN }); // <۲ساعت: هر دور
    const stale = await mk({ ageMs: 31 * 24 * H, error: P });
    const placeholder = await mk({ ageMs: 20 * MIN, authority: `pending:A5${n++}abcdefgh`, error: P });
    const sandbox = await mk({ ageMs: 20 * MIN, gateway: "sandbox" });
    const wallet = await mk({ ageMs: 20 * MIN, gateway: "wallet" });
    const paidAlready = await mk({ ageMs: 20 * MIN, status: "paid" });
    const got = new Set((await claimForVerification(50)).map((r) => r.authority));
    for (const r of [due, dueDaily, hourly, young]) expect(got.has(r.authority)).toBe(true);
    for (const r of [notYet, tooSoon, stale, placeholder, sandbox, wallet, paidAlready]) expect(got.has(r.authority)).toBe(false);
    // reconcile هم stale را گزارش می‌کند (بقیه‌ی ردیف‌ها بسته می‌شوند تا آزمون به درگاه واقعی تماس نگیرد)
    await db.update(payments).set({ status: "failed" }).where(and(eq(payments.status, "pending"), sql`${payments.id} <> ${stale.id}`));
    const rec = await reconcilePendingPayments();
    expect(rec.stale).toBeGreaterThanOrEqual(1);
    await clean();
  });

  it("برداشت اتمی و هم‌زمان: دو claim موازی یک ردیف را هم‌زمان برنمی‌دارند (SKIP LOCKED)", async () => {
    await clean();
    for (let i = 0; i < 12; i++) await mk({ ageMs: 30 * MIN + i * MIN });
    const [x, y] = await Promise.all([claimForVerification(6), claimForVerification(6)]);
    const all = [...x, ...y].map((r) => r.authority);
    expect(all.length).toBe(12);
    expect(new Set(all).size).toBe(12);
    await clean();
  });

  it("reconcile هم‌زمان تک‌پروازی است (دو فراخوانی هم‌زمان = یک اجرا) و پس از پایان دوباره اجرا می‌شود", async () => {
    await clean();
    const [r1, r2] = await Promise.all([reconcilePendingPayments(), reconcilePendingPayments()]);
    expect(r1).toBe(r2);
    const r3 = await reconcilePendingPayments();
    expect(r3).not.toBe(r1);
  });

  afterAll(async () => {
    await clean();
  });
});


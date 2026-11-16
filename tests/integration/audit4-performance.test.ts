/**
 * GLM Audit 4 — سرعت و عملکرد (P-01 · P-02 · P-03 · P-05 · P-06 · P-10)
 *
 * هر بخش یا باگِ واقعی را قفل می‌کند، یا (P-05 بخش «رندر داخل درخواست») نادرستیِ ادعا را اثبات می‌کند.
 * هیچ آزمون قبلی تغییر نکرده است؛ «اوراکل»‌ها نسخه‌ی قدیمیِ همان الگوریتم‌اند تا برابریِ رفتار اثبات شود.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, backgroundJobs, contractDocuments, contracts, contractSigners, tickets, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { fa } from "@/lib/jalali";
import { jalaliTokenRanges } from "@/lib/jalali-search";
import { matchesSearch } from "@/lib/search-text";
import { createSemaphore } from "@/lib/semaphore";
import { documentsDir } from "@/lib/storage-paths";
import { issueContract, listTags, queryUserContracts, listContractsForUser } from "@/modules/contracts/service";
import { stageOf } from "@/modules/signing/stages";
import { ensureGuestSigner } from "@/modules/guests/service";
import { getInsights } from "@/modules/insights/service";
import { drainJobs, enqueueJob, jobWorkerStats, jobsConcurrency, registerJobHandler, setJobsMode } from "@/modules/jobs/queue";
import { PdfTamperedError, hashFileStreaming, openContractPdf } from "@/modules/pdf/service";
import { createTicket, queryTickets, TICKET_COUNT_CAP } from "@/modules/tickets/service";
import { createWorkspace } from "@/modules/tenancy/service";
import { uniq } from "../helpers";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let seq = 0;
async function newOwner(label: string) {
  const [u] = await db
    .insert(users)
    .values({ name: label, email: `${uniq("a4")}@example.com`, mobile: `0913${String(6000000 + ++seq * 19)}`, passwordHash: hashPassword("Audit4x12345"), role: "user", emailVerifiedAt: new Date() })
    .returning();
  const ws = await createWorkspace(u.id, `فضای ${label}`);
  return { u, ws };
}
const guest = (ws: number, name: string) => ensureGuestSigner(ws, { name, mobile: `0914${String(7000000 + ++seq * 23)}` }).then((g) => g.userId);
const BODY = "<p>متن آزمایشی قرارداد برای ممیزی عملکرد و صفحه‌بندی.</p>";
const envBackup: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in envBackup)) envBackup[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
// دیتابیس آزمون بین فایل‌ها مشترک است؛ داده‌ی انبوه و کارهای مصنوعی این فایل نباید فایل‌های بعدی را کند/آلوده کنند
afterAll(async () => {
  await db.execute(sql`delete from contracts where number like 'BIG-%' or number like 'FILL-%' or number like 'TAG-%'`);
  await db.execute(sql`delete from tickets where number like 'BULK-%'`);
  await db.execute(sql`delete from background_jobs where type like 'perf.%' or (type = 'contract.finalize' and payload like '{"i":%')`);
  await db.execute(sql`vacuum analyze contracts, tickets`);
}, 120_000);
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete envBackup[k];
  }
  setJobsMode(undefined);
});

/* ═══════════════════ P-01 — داشبورد مشتری: SQL، صفحه‌بندی‌شده ═══════════════════ */
describe("P-01 — «قراردادهای من» در سطح SQL و صفحه‌بندی‌شده", () => {
  let customerId = 0;
  const WSNAME = "فضای داشبورد";

  // اوراکل: دقیقاً الگوریتم قدیمی (بارگذاری همه + stageOf + matchesSearch در جاوااسکریپت)
  async function oracle(userId: number) {
    const rows = await listContractsForUser(userId, "all");
    return rows;
  }
  const oracleSearch = (rows: Awaited<ReturnType<typeof oracle>>, q: string) =>
    rows.filter((r) => matchesSearch([r.title, r.number, r.workspaceName, r.myLabel, fa(r.issuedAt), r.signedAt ? fa(r.signedAt) : ""].join(" "), q));

  beforeAll(async () => {
    const { u, ws } = await newOwner("مالک داشبورد");
    await db.update((await import("@/db/schema")).workspaces).set({ name: WSNAME }).where(eq((await import("@/db/schema")).workspaces.id, ws));
    customerId = await guest(ws, "مشتری داشبورد");
    const other = await guest(ws, "طرف دیگر");
    const mk = (title: string, extra: Partial<Parameters<typeof issueContract>[0]> = {}) =>
      issueContract({ workspaceId: ws, title, bodyHtml: BODY, customerId, createdBy: u.id, ...extra });
    const ids: number[] = [];
    // ۱) نوبت من  ۲) منتظر دیگری (دیگری مرحله‌ی ۱، من مرحله‌ی ۲)  ۳) هم‌زمان (هر دو مرحله‌ی ۱ ⇒ نوبت من)
    ids.push(await mk("قرارداد پیمانکاری ساختمان"));
    ids.push(await mk("تفاهم‌نامه همکاری", { extraSigners: [{ label: "طرف اول", userId: other }] }));
    ids.push(await mk("قرارداد هم‌زمان", { extraSigners: [{ label: "طرف اول", userId: other }], signingMode: "parallel" }));
    ids.push(await mk("قرارداد امضاشده"));
    ids.push(await mk("قرارداد ردشده"));
    ids.push(await mk("قرارداد منقضی"));
    ids.push(await mk("قرارداد لغوشده"));
    // فیلرها با درج مستقیم (سقف ماهانه‌ی طرح رایگان برای صدور از مسیر عادی ۱۰ است)
    const fill = await db.execute<{ id: number }>(sql`
      insert into contracts (number, title, customer_id, body_html, workspace_id, status, issued_at)
      select 'FILL-' || ${ws} || '-' || g, 'فیلر شماره ' || g, ${customerId}, 'x', ${ws}, 'sent', now() - (g || ' hours')::interval
      from generate_series(1, 24) g returning id`);
    for (const r of fill.rows) {
      ids.push(r.id);
      await db.insert(contractSigners).values({ contractId: r.id, position: 1, label: "مشتری", userId: customerId });
    }
    await db.update(contractSigners).set({ status: "signed", signedAt: new Date() }).where(eq(contractSigners.contractId, ids[3]));
    await db.update(contracts).set({ status: "rejected" }).where(eq(contracts.id, ids[4]));
    await db.update(contracts).set({ status: "expired" }).where(eq(contracts.id, ids[5]));
    await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, ids[6]));
    // تاریخ‌های مشخص: ۱۴ مرداد ۱۴۰۴ (۲۰۲۵-۰۸-۰۵)، فروردین ۱۴۰۴، اردیبهشت ۱۴۰۳
    await db.update(contracts).set({ issuedAt: new Date("2025-08-05T08:00:00Z") }).where(eq(contracts.id, ids[0]));
    await db.update(contracts).set({ issuedAt: new Date("2025-03-25T08:00:00Z") }).where(eq(contracts.id, ids[1]));
    await db.update(contracts).set({ issuedAt: new Date("2024-05-10T08:00:00Z") }).where(eq(contracts.id, ids[2]));
    // پیش‌نویس هرگز نمایش داده نمی‌شود
    const draft = await mk("پیش‌نویس مخفی");
    await db.update(contracts).set({ status: "draft" }).where(eq(contracts.id, draft));
  }, 120_000);

  it("شمارنده‌ها و حالت‌ها با اوراکل قدیمی (همه‌ی ردیف‌ها در JS) برابرند", async () => {
    const all = await oracle(customerId);
    const page = await queryUserContracts(customerId, { filter: "all", pageSize: 200 });
    expect(page.counts.all).toBe(all.length);
    expect(page.counts.my_turn).toBe(all.filter((r) => r.state === "my_turn").length);
    expect(page.counts.waiting).toBe(all.filter((r) => r.state === "waiting").length);
    expect(page.counts.signed).toBe(all.filter((r) => r.state === "signed").length);
    expect(page.counts.closed).toBe(all.filter((r) => ["rejected", "expired", "cancelled"].includes(r.state)).length);
    expect(page.counts.pending).toBe(page.counts.my_turn + page.counts.waiting);
    // حالت‌های خاص: ترتیبی (منتظر)، هم‌زمان (نوبت من)، رد/منقضی/لغو، امضاشده؛ پیش‌نویس حذف
    const byTitle = new Map(page.rows.map((r) => [r.title, r.state]));
    expect(byTitle.get("تفاهم‌نامه همکاری")).toBe("waiting");
    expect(byTitle.get("قرارداد هم‌زمان")).toBe("my_turn");
    expect(byTitle.get("قرارداد پیمانکاری ساختمان")).toBe("my_turn");
    expect(byTitle.get("قرارداد ردشده")).toBe("rejected");
    expect(byTitle.get("قرارداد منقضی")).toBe("expired");
    expect(byTitle.get("قرارداد لغوشده")).toBe("cancelled");
    expect(byTitle.get("قرارداد امضاشده")).toBe("signed");
    expect(byTitle.has("پیش‌نویس مخفی")).toBe(false);
    // برابری ردیف‌به‌ردیف حالت
    const oracleState = new Map(all.map((r) => [r.id, r.state]));
    for (const r of page.rows) expect(r.state).toBe(oracleState.get(r.id));
    // ورودی ناقص‌ترین مرحله: مرحله‌ی من با stageOf در SQL همان در JS است
    expect(stageOf({ position: 2, stage: 0 })).toBe(2);
  });

  it("فقط «یک صفحه» ردیف برمی‌گردد؛ صفحه‌بندی دقیق و صفحه‌ی بیرون از بازه به آخرین صفحه کلمپ می‌شود", async () => {
    const p1 = await queryUserContracts(customerId, { filter: "all", pageSize: 20 });
    expect(p1.rows).toHaveLength(20);
    expect(p1.total).toBe(p1.counts.all);
    expect(p1.pages).toBe(Math.ceil(p1.counts.all / 20));
    const p2 = await queryUserContracts(customerId, { filter: "all", pageSize: 20, page: 2 });
    expect(p2.rows.length).toBe(p1.counts.all - 20);
    expect(new Set([...p1.rows, ...p2.rows].map((r) => r.id)).size).toBe(p1.counts.all); // بدون تکرار/جاافتادگی
    const far = await queryUserContracts(customerId, { filter: "all", pageSize: 20, page: 999 });
    expect(far.page).toBe(far.pages);
    expect(far.rows.map((r) => r.id)).toEqual(p2.rows.map((r) => r.id));
    // مرتب‌سازی: جدیدترین صدور اول، با شکستن تساوی روی id (صفحه‌بندی پایدار)
    const t = [...p1.rows, ...p2.rows].map((r) => r.issuedAt.getTime());
    expect([...t].sort((a, b) => b - a)).toEqual(t);
  });

  it("فیلتر تب‌ها (نوبت من / در انتظار / امضاشده / بسته) مثل قبل", async () => {
    const all = await oracle(customerId);
    for (const [f, pred] of [
      ["my_turn", (s: string) => s === "my_turn"],
      ["pending", (s: string) => s === "my_turn" || s === "waiting"],
      ["signed", (s: string) => s === "signed"],
      ["closed", (s: string) => ["rejected", "expired", "cancelled"].includes(s)],
    ] as const) {
      const got = await queryUserContracts(customerId, { filter: f, pageSize: 200 });
      expect(got.rows.map((r) => r.id).sort()).toEqual(all.filter((r) => pred(r.state)).map((r) => r.id).sort());
      expect((await listContractsForUser(customerId, f)).length).toBe(got.total);
    }
  });

  it("جستجو در SQL با اوراکل JS یکی است: عنوان (ي/ك عربی)، فرستنده، ارقام فارسی، چندواژه‌ای، تاریخ شمسی (سال/ماه)", async () => {
    const all = await oracle(customerId);
    for (const q of ["پيمانكاري", "فیلر", "فیلر شماره ۱۲", WSNAME, "طرف اول", "تفاهم نامه", "مرداد", "1404", "۱۴۰۴", "اردیبهشت", "نامه همکاری", "هیچ‌چیز-پیدا-نمی‌شود"]) {
      const want = oracleSearch(all, q).map((r) => r.id).sort();
      const got = await queryUserContracts(customerId, { filter: "all", q, pageSize: 200 });
      expect(got.rows.map((r) => r.id).sort(), `q=${q}`).toEqual(want);
      expect(got.counts.all, `count q=${q}`).toBe(want.length);
      expect(got.totals.all).toBe(all.length); // کارت‌های آمار «بدون جستجو»
    }
    // ضدتزریق: نویسه‌های LIKE/نقل‌قول، خطا نمی‌دهند و چیزی را بی‌دلیل مطابقت نمی‌دهند
    for (const q of ["%", "_", "\\", "'; drop table contracts; --", '"']) {
      const got = await queryUserContracts(customerId, { q, pageSize: 5 });
      expect(got.rows.length).toBeLessThanOrEqual(5);
    }
    expect((await queryUserContracts(customerId, { q: "%" })).counts.all).toBe(0);
  });

  it("تاریخ شمسی کامل با جداکننده (۱۴۰۴/۰۵) و روزِ ماه به بازه‌ی درست تبدیل می‌شود", async () => {
    const got = await queryUserContracts(customerId, { q: "1404/05", pageSize: 200 });
    expect(got.rows.map((r) => r.title)).toContain("قرارداد پیمانکاری ساختمان");
    expect(got.rows.map((r) => r.title)).not.toContain("تفاهم‌نامه همکاری");
    const day = await queryUserContracts(customerId, { q: "1404/05/14", pageSize: 200 });
    expect(day.rows.map((r) => r.title)).toEqual(["قرارداد پیمانکاری ساختمان"]);
    const r = jalaliTokenRanges("۱۴۰۴/۰۵/۱۴")!;
    expect(r).toHaveLength(1);
    expect(r[0].from.toISOString()).toBe("2025-08-04T20:30:00.000Z"); // نیمه‌شب تهران = ۲۰:۳۰ UTC روز قبل
    expect(r[0].to.getTime() - r[0].from.getTime()).toBe(86_400_000);
    expect(jalaliTokenRanges("سلام")).toBeNull();
    expect(jalaliTokenRanges("x")).toBeNull();
  });
});

/* ═══════════════════ P-02 — روند روزانه‌ی بینش‌ها ═══════════════════ */
describe("P-02 — روند ۳۰ روزه‌ی بینش‌ها: یک GROUP BY، نه ≈۶۰ اسکن", () => {
  // اوراکل: همان SQL قدیمی (۶۰ زیرپرس‌وجوی هم‌بسته)
  const TEH = (col: string) => `((${col} at time zone 'UTC') at time zone 'Asia/Tehran')`;
  const oldDaily = (wsId: number) =>
    db.execute<{ day: string; issued: number; signed: number }>(sql`
    select to_char(d::date, 'YYYY-MM-DD') as day,
      (select count(*)::int from contracts c where c.workspace_id = ${wsId} and c.status <> 'draft' and ${sql.raw(TEH("c.issued_at"))}::date = d::date) as issued,
      (select count(*)::int from contracts c where c.workspace_id = ${wsId} and c.status = 'signed' and ${sql.raw(TEH("c.signed_at"))}::date = d::date) as signed
    from generate_series((now() at time zone 'Asia/Tehran')::date - 29, (now() at time zone 'Asia/Tehran')::date, interval '1 day') d
    order by d`);

  it("خروجی دقیقاً برابر نسخه‌ی قدیمی است (مرز نیمه‌شب تهران، پیش‌نویس، ۳۰ روز اخیر، خارج از بازه)", async () => {
    const { u, ws } = await newOwner("بینش");
    const c = await guest(ws, "مشتری بینش");
    const mk = async (title: string) => issueContract({ workspaceId: ws, title, bodyHtml: BODY, customerId: c, createdBy: u.id });
    const day = 86_400_000;
    const now = Date.now();
    const ids = [await mk("a"), await mk("b"), await mk("c"), await mk("d"), await mk("e"), await mk("f")];
    await db.update(contracts).set({ issuedAt: new Date(now - 2 * day) }).where(eq(contracts.id, ids[0]));
    await db.update(contracts).set({ issuedAt: new Date(now - 2 * day), status: "signed", signedAt: new Date(now - day) }).where(eq(contracts.id, ids[1]));
    // ۰۰:۱۰ تهران (۲۰:۴۰ UTC روز قبل) و ۲۳:۵۰ تهران
    const midnight = new Date(new Date(now - 5 * day).toISOString().slice(0, 10) + "T20:40:00Z");
    await db.update(contracts).set({ issuedAt: midnight }).where(eq(contracts.id, ids[2]));
    await db.update(contracts).set({ issuedAt: new Date(now - 45 * day), status: "signed", signedAt: new Date(now - 44 * day) }).where(eq(contracts.id, ids[3])); // بیرون از ۳۰ روز
    await db.update(contracts).set({ status: "draft", issuedAt: new Date(now - day) }).where(eq(contracts.id, ids[4]));
    await db.update(contracts).set({ issuedAt: new Date(now - 29 * day), status: "signed", signedAt: new Date(now - 29 * day + 3_600_000) }).where(eq(contracts.id, ids[5]));
    const want = (await oldDaily(ws)).rows.map((r) => ({ day: r.day, issued: Number(r.issued), signed: Number(r.signed) }));
    const got = (await getInsights(ws)).daily;
    expect(got).toEqual(want);
    expect(got).toHaveLength(30);
    expect(got.reduce((s, r) => s + r.issued, 0)).toBeGreaterThanOrEqual(4);
  });

  it("روی فضای بزرگ (۳۰هزار قرارداد) نسخه‌ی جدید چند برابر سریع‌تر است و از ایندکس استفاده می‌کند", async () => {
    const { ws } = await newOwner("بینش بزرگ");
    const c = await guest(ws, "مشتری بزرگ");
    await db.execute(sql`
      insert into contracts (number, title, customer_id, body_html, workspace_id, status, issued_at, signed_at)
      select 'BIG-' || ${ws} || '-' || g, 't' || g, ${c}, 'x', ${ws},
             case when g % 3 = 0 then 'signed' else 'sent' end,
             now() - (g % 400 || ' days')::interval - ((g % 1440) || ' minutes')::interval,
             case when g % 3 = 0 then now() - (g % 400 || ' days')::interval else null end
      from generate_series(1, 30000) g`);
    await db.execute(sql`analyze contracts`);
    const time = async (fn: () => Promise<unknown>) => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        await fn();
        best = Math.min(best, performance.now() - t);
      }
      return best;
    };
    const oldMs = await time(() => oldDaily(ws));
    const newMs = await time(() => getInsights(ws));
    // getInsights شامل ۵ پرس‌وجوی دیگر هم هست؛ با این حال باید از «فقط روند قدیمی» سریع‌تر باشد
    expect(newMs).toBeLessThan(oldMs);
    // خروجی روی داده‌ی بزرگ هم برابر است
    expect((await getInsights(ws)).daily).toEqual((await oldDaily(ws)).rows.map((r) => ({ day: r.day, issued: Number(r.issued), signed: Number(r.signed) })));
    const idx = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'contracts' and indexname in ('contracts_ws_issued_idx', 'contracts_ws_signed_idx')`);
    expect(idx.rows.map((r) => r.indexname).sort()).toEqual(["contracts_ws_issued_idx", "contracts_ws_signed_idx"]);
  }, 120_000);
});

/* ═══════════════════ P-03 — فهرست برچسب‌ها ═══════════════════ */
describe("P-03 — listTags: تجمیع در PostgreSQL", () => {
  it("برابر الگوریتم قدیمی (JS)؛ ترتیب: تعداد نزولی؛ سقف ۴۰؛ فضای دیگر نشت نمی‌کند", async () => {
    const { ws } = await newOwner("برچسب");
    const other = await newOwner("برچسب دیگر");
    const c = await guest(ws, "مشتری برچسب");
    const co = await guest(other.ws, "مشتری دیگر");
    const tagSets = ["vip,urgent", "vip", "vip, نیاز به پیگیری ,x", "urgent,,  ,", "", "تکراری,تکراری", "تکراری,تکراری", "تکراری,تکراری"];
    for (let i = 0; i < 12; i++) tagSets.push(`t${String(i).padStart(2, "0")},vip`);
    for (let i = 0; i < 50; i++) tagSets.push(`bulk${String(i).padStart(2, "0")}`);
    const rows = tagSets.map((tags, i) => ({ number: `TAG-${ws}-${i}`, title: `t${i}`, customerId: c, bodyHtml: "x", workspaceId: ws, tags }));
    await db.insert(contracts).values(rows);
    await db.insert(contracts).values({ number: `TAG-${other.ws}-1`, title: "other", customerId: co, bodyHtml: "x", workspaceId: other.ws, tags: "secret-other-ws,vip" });
    // اوراکل قدیمی (با یکتاسازی برچسب در هر قرارداد؛ normalizeTags هنگام ذخیره هم تکراری را حذف می‌کند)
    const all = await db.select({ tags: contracts.tags }).from(contracts).where(eq(contracts.workspaceId, ws));
    const m = new Map<string, number>();
    for (const r of all) for (const t of new Set(r.tags.split(",").map((x) => x.trim()).filter(Boolean))) m.set(t, (m.get(t) ?? 0) + 1);
    const wantTop = [...m.entries()].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || (a.tag < b.tag ? -1 : 1)).slice(0, 40);
    const got = await listTags(ws);
    expect(got).toHaveLength(40);
    expect(got).toEqual(wantTop); // نام، تعداد و ترتیب (تعداد نزولی، تساوی: الفبایی)
    // vip: ۱+۱+۱+۱۲ = ۱۵ (فقط همین فضا) و در رأس
    expect(got[0]).toEqual({ tag: "vip", n: 15 });
    expect(got.find((g) => g.tag === "تکراری")?.n).toBe(3); // یک‌بار برای هر قرارداد (نه ۶)
    expect(got.some((g) => g.tag === "secret-other-ws")).toBe(false);
    expect(got.some((g) => g.tag === "")).toBe(false);
    expect(await listTags(999_999)).toEqual([]);
  });

  it("ایندکس جزئی برچسب وجود دارد و فقط ردیف‌های دارای برچسب را شامل می‌شود", async () => {
    const r = await db.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where indexname = 'contracts_ws_tags_idx'`);
    expect(r.rows[0]?.indexdef).toMatch(/WHERE/i);
    expect(r.rows[0]?.indexdef).toContain("tags");
  });
});

/* ═══════════════════ P-05 — دانلود PDF ═══════════════════ */
describe("P-05 — دانلود PDF: هش جریانی با حافظه‌ی ثابت (راستی‌آزمایی حفظ شده)", () => {
  const files: string[] = [];
  afterAll(() => files.forEach((f) => fs.rmSync(f, { force: true })));
  async function seedPdf(sizeBytes: number) {
    const { u, ws } = await newOwner("پی‌دی‌اف");
    const c = await guest(ws, "مشتری پی‌دی‌اف");
    const id = await issueContract({ workspaceId: ws, title: "سند بزرگ", bodyHtml: BODY, customerId: c, createdBy: u.id });
    const buf = crypto.randomBytes(sizeBytes);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const file = `P05-${id}-${sha.slice(0, 8)}.pdf`;
    fs.mkdirSync(documentsDir(), { recursive: true });
    const p = path.join(documentsDir(), file);
    fs.writeFileSync(p, buf);
    files.push(p);
    await db.insert(contractDocuments).values({ contractId: id, file, sha256: sha, size: buf.length });
    return { id, buf, sha, p };
  }
  async function collect(s: ReadableStream<Uint8Array>) {
    const chunks: Buffer[] = [];
    let max = 0;
    const reader = s.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      max = Math.max(max, value.length);
      chunks.push(Buffer.from(value));
    }
    return { body: Buffer.concat(chunks), count: chunks.length, max };
  }

  it("فایل ۵ مگابایتی: بایت‌به‌بایت یکسان، در چندین تکه‌ی کوچک (هرگز یک Buffer کامل) ارسال می‌شود", async () => {
    const { id, buf, sha } = await seedPdf(5 * 1024 * 1024);
    const pdf = await openContractPdf(id);
    expect(pdf.sha256).toBe(sha);
    expect(pdf.size).toBe(buf.length);
    const { body, count, max } = await collect(pdf.stream());
    expect(body.equals(buf)).toBe(true);
    expect(count).toBeGreaterThan(20);
    expect(max).toBeLessThanOrEqual(1024 * 1024);
  });

  it("دانلود ادامه‌دار (Range): فقط همان بازه از دیسک خوانده می‌شود", async () => {
    const { id, buf } = await seedPdf(300_000);
    const pdf = await openContractPdf(id);
    const { body } = await collect(pdf.stream({ start: 1000, end: 2999 }));
    expect(body.equals(buf.subarray(1000, 3000))).toBe(true);
  });

  it("دستکاری فایل: PdfTamperedError + ثبت در ممیزی (تضمین قبلی حفظ شده)", async () => {
    const { id, buf, p } = await seedPdf(200_000);
    const bad = Buffer.from(buf);
    bad[777] ^= 0xff;
    fs.writeFileSync(p, bad);
    await expect(openContractPdf(id)).rejects.toBeInstanceOf(PdfTamperedError);
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.contractId, id));
    expect(rows.some((r) => r.action === "document.tampered")).toBe(true);
  });

  it("دستکاری «بین راستی‌آزمایی و ارسال»: جریان با خطا قطع و در ممیزی ثبت می‌شود (دانلودِ مسموم تمام‌شده تلقی نمی‌شود)", async () => {
    const { id, buf, p } = await seedPdf(400_000);
    const pdf = await openContractPdf(id);
    const bad = Buffer.from(buf);
    bad[123_456] ^= 0x01;
    fs.writeFileSync(p, bad);
    await expect(collect(pdf.stream())).rejects.toBeInstanceOf(PdfTamperedError);
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.contractId, id));
    expect(rows.filter((r) => r.action === "document.tampered").length).toBeGreaterThan(0);
  });

  it("hashFileStreaming با هش درون‌حافظه یکی است", async () => {
    const { buf, sha, p } = await seedPdf(70_000);
    const r = await hashFileStreaming(p);
    expect(r).toEqual({ sha256: sha, size: buf.length });
  });

  it("ادعای «اولین دانلود در دل درخواست رندر می‌شود» نادرست است: پایان امضا، کار contract.finalize را در صف می‌گذارد (PDF پیش از دانلود ساخته می‌شود)", () => {
    const finalize = fs.readFileSync(path.resolve(__dirname, "../../src/modules/signing/finalize.ts"), "utf8");
    expect(finalize).toMatch(/enqueueJob\("contract\.finalize"/);
    const handlers = fs.readFileSync(path.resolve(__dirname, "../../src/modules/jobs/handlers.ts"), "utf8");
    expect(handlers).toMatch(/registerJobHandler\("contract\.finalize"[\s\S]*generateContractPdf\(contractId\)/);
  });

  it("سمافور رندر: هرگز بیش از سقف کار هم‌زمان، خطا جایگاه را آزاد می‌کند، FIFO", async () => {
    const sem = createSemaphore(2);
    let cur = 0;
    let max = 0;
    const order: number[] = [];
    const job = (i: number, fail = false) =>
      sem.run(async () => {
        order.push(i);
        cur++;
        max = Math.max(max, cur);
        await sleep(30);
        cur--;
        if (fail) throw new Error("boom");
      });
    const res = await Promise.allSettled([job(1), job(2, true), job(3), job(4), job(5)]);
    expect(max).toBe(2);
    expect(res[1].status).toBe("rejected");
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(sem.active).toBe(0);
  });
});

/* ═══════════════════ P-06 — کارگر صف ═══════════════════ */
describe("P-06 — کارگر صف: هم‌زمان (نه سریالی) با سقف نوعی", () => {
  beforeAll(async () => {
    await import("@/modules/jobs/handlers"); // handlerهای واقعی ابتدا ثبت شوند؛ نسخه‌های آزمون بعدش جایگزین می‌شوند
  });
  const state = { cur: 0, max: 0, fin: 0, finMax: 0, runs: new Map<string, number>(), done: [] as string[] };
  const reset = () => Object.assign(state, { cur: 0, max: 0, fin: 0, finMax: 0, runs: new Map<string, number>(), done: [] as string[] });
  const track = (key: string) => state.runs.set(key, (state.runs.get(key) ?? 0) + 1);

  registerJobHandler("perf.slow", {
    async run(p) {
      track(String(p.k));
      state.cur++;
      state.max = Math.max(state.max, state.cur);
      await sleep(Number(p.ms ?? 400));
      state.cur--;
      state.done.push(String(p.k));
    },
  });
  registerJobHandler("perf.fast", {
    async run(p) {
      track(String(p.k));
      state.done.push(String(p.k));
    },
  });

  async function clean() {
    await db.delete(backgroundJobs);
  }

  it("پیش‌فرض ۴ کارگر در background و ۱ در inline؛ ورودی نامعتبر به پیش‌فرض برمی‌گردد", () => {
    setJobsMode("background");
    expect(jobsConcurrency()).toBe(4);
    setEnv("JOBS_CONCURRENCY", "8");
    expect(jobsConcurrency()).toBe(8);
    setEnv("JOBS_CONCURRENCY", "abc");
    expect(jobsConcurrency()).toBe(4);
    setEnv("JOBS_CONCURRENCY", "0");
    expect(jobsConcurrency()).toBe(4);
    setJobsMode("inline");
    expect(jobsConcurrency()).toBe(1);
  });

  it("قبل از اصلاح (JOBS_CONCURRENCY=1 ≡ رفتار سریالی قدیمی): کار کوتاه پشت کارهای کند می‌ماند؛ بعد از اصلاح (۴) فوراً اجرا می‌شود", async () => {
    // سریالی
    await clean();
    reset();
    setJobsMode("background");
    setEnv("JOBS_CONCURRENCY", "1");
    for (let i = 0; i < 3; i++) await enqueueJob("perf.slow", { k: `s${i}`, ms: 250 }, { kick: false });
    await sleep(5);
    await enqueueJob("perf.fast", { k: "fast" }, { kick: false });
    await drainJobs();
    expect(state.max).toBe(1);
    expect(state.done.indexOf("fast")).toBe(3); // آخر از همه
    // هم‌زمان
    await clean();
    reset();
    setEnv("JOBS_CONCURRENCY", "4");
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) await enqueueJob("perf.slow", { k: `p${i}`, ms: 250 }, { kick: false });
    await sleep(5);
    await enqueueJob("perf.fast", { k: "fast" }, { kick: false });
    await drainJobs();
    const total = performance.now() - t0;
    expect(state.max).toBe(3);
    expect(state.done[0]).toBe("fast"); // کوتاه، پشت کندها گیر نکرد
    expect(total).toBeLessThan(250 * 3 * 0.8); // به‌جای ≈۷۵۰ms سریالی، ≈۲۵۰ms
  });

  it("سقف کل رعایت می‌شود (۶ کار کند، JOBS_CONCURRENCY=3 ⇒ حداکثر ۳ هم‌زمان) و همه دقیقاً یک‌بار اجرا می‌شوند", async () => {
    await clean();
    reset();
    setJobsMode("background");
    setEnv("JOBS_CONCURRENCY", "3");
    for (let i = 0; i < 6; i++) await enqueueJob("perf.slow", { k: `c${i}`, ms: 120 }, { kick: false });
    await drainJobs();
    expect(state.max).toBe(3);
    expect(state.runs.size).toBe(6);
    expect([...state.runs.values()].every((n) => n === 1)).toBe(true);
    const st = await db.select({ s: backgroundJobs.status }).from(backgroundJobs);
    expect(st.every((r) => r.s === "done")).toBe(true);
  });

  it("سقف نوعی: contract.finalize حداکثر ۲ هم‌زمان؛ کار دیگر همان لحظه آزادانه اجرا می‌شود", async () => {
    await clean();
    reset();
    registerJobHandler("contract.finalize", {
      async run(p) {
        track(`fin${p.i}`);
        state.fin++;
        state.finMax = Math.max(state.finMax, state.fin);
        await sleep(200);
        state.fin--;
        state.done.push(`fin${p.i}`);
      },
    });
    setJobsMode("background");
    setEnv("JOBS_CONCURRENCY", "6");
    for (let i = 0; i < 6; i++) await enqueueJob("contract.finalize", { i }, { kick: false });
    await sleep(5);
    await enqueueJob("perf.fast", { k: "fast-while-finalizing" }, { kick: false });
    await drainJobs();
    expect(state.finMax).toBe(2);
    expect(state.runs.size).toBe(7);
    // کار سبک نباید پشت ۶ finalize بماند (با وجود پر بودن سقف finalize)
    expect(state.done.indexOf("fast-while-finalizing")).toBeLessThan(2);
    setEnv("JOBS_FINALIZE_CONCURRENCY", "1");
    reset();
    await clean();
    for (let i = 0; i < 3; i++) await enqueueJob("contract.finalize", { i }, { kick: false });
    await drainJobs();
    expect(state.finMax).toBe(1);
  });

  it("شکست و تلاش دوباره (retry/backoff) و dead در حالت هم‌زمان مثل قبل کار می‌کند", async () => {
    await clean();
    reset();
    let n = 0;
    registerJobHandler("perf.flaky", {
      async run() {
        n++;
        throw new Error("fail-always");
      },
      onDead: async () => void state.done.push("dead-hook"),
    });
    setJobsMode("background");
    await enqueueJob("perf.flaky", {}, { kick: false, maxAttempts: 2 });
    await drainJobs();
    const [j] = await db.select().from(backgroundJobs);
    expect(j.status).toBe("pending"); // تلاش اول شکست خورد، با backoff به آینده رفت
    expect(j.attempts).toBe(1);
    expect(n).toBe(1);
    await db.update(backgroundJobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(backgroundJobs.id, j.id));
    await drainJobs();
    const [j2] = await db.select().from(backgroundJobs);
    expect(j2.status).toBe("dead");
    expect(state.done).toContain("dead-hook");
  });

  it("کارِ تازه هنگام خروج کارگرها گم نمی‌شود (kick پشت‌سرهم + درج هم‌زمان): ۴۰ کار، هرکدام دقیقاً یک‌بار", async () => {
    await clean();
    reset();
    setJobsMode("background");
    setEnv("JOBS_CONCURRENCY", "4");
    const drains: Promise<void>[] = [];
    for (let i = 0; i < 40; i++) {
      await enqueueJob("perf.fast", { k: `w${i}` }, { kick: false });
      if (i % 3 === 0) drains.push(drainJobs());
      if (i % 7 === 0) await sleep(2);
    }
    await Promise.all(drains);
    await drainJobs();
    expect(state.runs.size).toBe(40);
    expect([...state.runs.values()].every((c) => c === 1)).toBe(true);
    const left = await db.select().from(backgroundJobs).where(inArray(backgroundJobs.status, ["pending", "running"]));
    expect(left).toHaveLength(0);
    expect(jobWorkerStats().live).toBe(0);
    expect(jobWorkerStats().running).toBe(0);
  });

  it("حالت inline (آزمون‌های قدیمی) همچنان همگام و سریالی است", async () => {
    await clean();
    reset();
    setJobsMode("inline");
    for (let i = 0; i < 3; i++) await enqueueJob("perf.slow", { k: `i${i}`, ms: 40 }, { kick: false });
    await drainJobs();
    expect(state.max).toBe(1);
    expect(state.runs.size).toBe(3);
  });
});

/* ═══════════════════ P-10 — جستجوی تیکت‌ها ═══════════════════ */
describe("P-10 — جستجوی تیکت: ایندکس trigram + UNION + شمارش سقف‌دار", () => {
  let userId = 0;
  let wsId = 0;
  beforeAll(async () => {
    const { u, ws } = await newOwner("پشتیبانی");
    userId = u.id;
    wsId = ws;
  });

  it("جستجو در موضوع/شماره/نام/ایمیل (با گونه‌های ي/ك و ارقام فارسی) و فیلترها درست است", async () => {
    const a = await createTicket({ userId, workspaceId: wsId, subject: "مشکل در پرداخت قسط", category: "billing", priority: "high", body: "سلام" });
    const b = await createTicket({ userId, workspaceId: wsId, subject: "سؤال درباره امضای ۱۴۰۴", category: "general", priority: "normal", body: "سلام" });
    const [ta] = await db.select().from(tickets).where(eq(tickets.id, a));
    const ids = async (f: Parameters<typeof queryTickets>[0]) => (await queryTickets(f)).rows.map((r) => r.ticket.id);
    expect(await ids({ q: "پرداخت قسط" })).toContain(a);
    expect(await ids({ q: "پرداخت قسط" })).not.toContain(b);
    expect(await ids({ q: "امضاي 1404" })).toContain(b); // ي عربی + ارقام لاتین
    expect(await ids({ q: ta.number.toLowerCase() })).toEqual([a]); // شماره (ILIKE بدون حساسیت به حروف)
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(await ids({ q: u.email.slice(0, 12) })).toEqual(expect.arrayContaining([a, b])); // ایمیل کاربر
    expect(await ids({ q: u.name })).toEqual(expect.arrayContaining([a, b])); // نام کاربر
    expect(await ids({ q: "پرداخت", priority: "high" })).toEqual([a]);
    expect(await ids({ q: "پرداخت", category: "general" })).toEqual([]);
    // نویسه‌های ویژه‌ی LIKE و تزریق
    expect(await ids({ q: "%" })).toEqual([]);
    expect(await ids({ q: "'; drop table tickets;--" })).toEqual([]);
    expect((await queryTickets({ q: "x".repeat(500) })).rows).toEqual([]);
  });

  it("شمارش سقف‌دار: روی ۱۰٬۰۵۰ تیکت count هرگز بیش از سقف نمی‌خواند؛ صفحه‌ی ناقص بدون count", async () => {
    await db.execute(sql`
      insert into tickets (number, user_id, workspace_id, subject, updated_at)
      select 'BULK-' || g, ${userId}, ${wsId}, 'موضوع انبوه ' || md5(g::text), now() - (g || ' seconds')::interval
      from generate_series(1, ${TICKET_COUNT_CAP + 50}) g`);
    await db.execute(sql`vacuum analyze tickets`); // vacuum: pending-list ایندکس GIN را ادغام می‌کند
    const full = await queryTickets({ page: 1 });
    expect(full.rows).toHaveLength(25);
    expect(full.total).toBe(TICKET_COUNT_CAP);
    expect(full.totalCapped).toBe(true);
    expect(full.pages).toBe(Math.ceil(TICKET_COUNT_CAP / 25));
    // صفحه‌ی بیرون از سقف: به آخرین صفحه‌ی قابل‌نمایش کلمپ می‌شود
    const far = await queryTickets({ page: 99_999 });
    expect(far.page).toBe(far.pages);
    expect(far.rows.length).toBeGreaterThan(0);
    // جستجوی دقیق: صفحه‌ی ناقص ⇒ total همان تعداد واقعی (بدون count)
    const one = await queryTickets({ q: "BULK-10049" });
    expect(one.totalCapped).toBe(false);
    expect(one.total).toBe(one.rows.length);
    expect(one.rows.length).toBe(1);
    expect(one.rows.every((r) => r.ticket.number.includes("BULK-10049"))).toBe(true);
  }, 60_000);

  it("ایندکس‌های trigram موضوع/شماره ساخته شده‌اند و planner در جستجوی زیررشته از آن‌ها (نه Seq Scan) استفاده می‌کند", async () => {
    const idx = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'tickets' and indexname like '%trgm%'`);
    expect(idx.rows.map((r) => r.indexname).sort()).toEqual(["tickets_number_trgm_idx", "tickets_subject_trgm_idx"]);
    await db.execute(sql`vacuum analyze tickets`);
    const plan = await db.execute<{ "QUERY PLAN": string }>(sql`explain select id from tickets t where t.subject ilike '%' || md5('4242') || '%' or t.number ilike '%BULK-4242%'`);
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/tickets_subject_trgm_idx/);
    expect(text).toMatch(/tickets_number_trgm_idx/);
    expect(text).toMatch(/BitmapOr/);
  });
});

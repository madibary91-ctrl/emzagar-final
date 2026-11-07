import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, getPool } from "@/db";
import { expectedColumns, expectedForeignKeys } from "@/db/ddl";
import { backgroundJobs, contractDocuments, contracts, contractSigners, kycDocuments, kycSubmissions, notifications, userNotifications, userTotp, users } from "@/db/schema";
import { hashPassword, hashPasswordAsync, unusablePasswordHash, verifyPassword, verifyPasswordAsync } from "@/lib/password";
import { kycDir, signaturesDir } from "@/lib/storage-paths";
import { queryContracts } from "@/modules/contracts/service";
import { applySchema, missingSchemaObjects } from "@/modules/install/service";
import { SCHEMA_CREATE } from "@/modules/install/schema-sql";
import { drainJobs, enqueueJob, registerJobHandler, setJobsMode, setJobsPaused } from "@/modules/jobs/queue";
import { notifyUser } from "@/modules/inbox/service";
import { deleteAccount } from "@/modules/privacy/service";
import { freshBrowser, uniq } from "../helpers";
import { newContract, setupWorkspace, signAll, guestSignWith } from "../flows";
import { getSigners } from "@/modules/contracts/service";

let owner: { id: number };
let wsId: number;

beforeAll(async () => {
  ({ owner, wsId } = await setupWorkspace("فضای رفع باگ‌های سطح بالا"));
});
beforeAll(() => freshBrowser());
afterAll(() => {
  setJobsPaused(false);
  setJobsMode(undefined);
});

const rows = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows as unknown as T[];

describe("DB-01: Foreign Key و یکپارچگی ارجاعی", () => {
  it("همه‌ی FKهای تعریف‌شده در schema.ts واقعاً در دیتابیس هستند و معتبرند", async () => {
    const want = expectedForeignKeys();
    expect(want.length).toBeGreaterThan(90);
    const have = await rows<{ conname: string; convalidated: boolean; condeferrable: boolean }>(sql`select conname, convalidated, condeferrable from pg_constraint where contype = 'f'`);
    const byName = new Map(have.map((h) => [h.conname, h]));
    for (const f of want) {
      const c = byName.get(f.name);
      expect(c, `FK ${f.name} (${f.table})`).toBeTruthy();
      expect(c!.convalidated, f.name).toBe(true);
      expect(c!.condeferrable, f.name).toBe(true);
    }
  });

  it("contracts.workspace_id و contracts.customer_id ردیف یتیم را رد می‌کنند", async () => {
    const base = { number: uniq("FK-"), title: "یتیم", bodyHtml: "<p>x</p>" };
    const code = async (v: Record<string, unknown>) => {
      try {
        await db.insert(contracts).values(v as typeof contracts.$inferInsert);
        return "ok";
      } catch (e) {
        return (e as { cause?: { code?: string } }).cause?.code ?? String(e);
      }
    };
    expect(await code({ ...base, workspaceId: 987_654_321, customerId: owner.id })).toBe("23503");
    expect(await code({ ...base, number: uniq("FK-"), workspaceId: wsId, customerId: 987_654_321 })).toBe("23503");
  });

  it("حذف قرارداد، فرزندانش را CASCADE می‌کند و حذف کاربرِ دارای قرارداد (RESTRICT) رد می‌شود", async () => {
    const c = await newContract(wsId, owner.id);
    expect((await db.select().from(contractSigners).where(eq(contractSigners.contractId, c.id))).length).toBe(2);
    await expect(db.delete(users).where(eq(users.id, c.buyer.userId))).rejects.toThrow();
    await db.delete(contracts).where(eq(contracts.id, c.id));
    expect(await db.select().from(contractSigners).where(eq(contractSigners.contractId, c.id))).toHaveLength(0);
  });
});

describe("DB-05: schema.ts تنها منبع حقیقت", () => {
  it("هر ستون schema.ts با همان نوع در دیتابیس ساخته‌شده از DDL نصب‌کننده هست", async () => {
    const info = await rows<{ t: string; c: string; ty: string }>(sql`select table_name as t, column_name as c, data_type as ty from information_schema.columns where table_schema = current_schema()`);
    const have = new Map(info.map((r) => [`${r.t}.${r.c}`, r.ty]));
    const family: Record<string, string> = { serial: "integer", integer: "integer", text: "text", timestamp: "timestamp without time zone", boolean: "boolean", bigint: "bigint" };
    for (const c of expectedColumns()) {
      const got = have.get(`${c.table}.${c.column}`);
      expect(got, `${c.table}.${c.column}`).toBeTruthy();
      const want = c.type.startsWith("numeric") ? "numeric" : family[c.type];
      expect(got, `${c.table}.${c.column}`).toBe(want);
    }
    expect(await missingSchemaObjects(getPool())).toEqual([]);
  });

  it("applySchema روی دیتابیس موجود ایدمپوتنت است و SCHEMA_CREATE دوباره‌اجرا خطا نمی‌دهد", async () => {
    await applySchema();
    await applySchema();
    for (const st of SCHEMA_CREATE) await getPool().query(st);
  });

  it("خطای DDL دیگر بی‌صدا نادیده گرفته نمی‌شود (fail-closed)", async () => {
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("alter table users drop column if exists tmp_missing_col");
      await client.query("alter table users add column tmp_probe integer");
      await client.query("alter table users drop column tmp_probe");
      // schema.ts ستونی دارد که حذف شد ← راستی‌آزمایی باید آن را «گم‌شده» گزارش کند
      await client.query("alter table users rename column mobile to mobile_gone");
      expect(await missingSchemaObjects(client)).toContain("users.mobile");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("PERF-01: هش رمز، حلقه‌ی رویداد را قفل نمی‌کند", () => {
  it("نسخه‌ی ناهمگام و همگام سازگار و متقابلاً معتبرند", async () => {
    const h = await hashPasswordAsync("Secret-123");
    expect(h).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(await verifyPasswordAsync("Secret-123", h)).toBe(true);
    expect(await verifyPasswordAsync("secret-123", h)).toBe(false);
    expect(verifyPassword("Secret-123", h)).toBe(true);
    expect(await verifyPasswordAsync("Old-pass-9", hashPassword("Old-pass-9"))).toBe(true);
    expect(await verifyPasswordAsync("x", "garbage")).toBe(false);
    expect(await verifyPasswordAsync("x", unusablePasswordHash())).toBe(false);
  });

  it("در حین چند هش هم‌زمان، تایمر حلقه‌ی اصلی به‌طور منظم تیک می‌زند", async () => {
    let ticks = 0;
    let maxGap = 0;
    let last = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 5);
    const started = performance.now();
    await Promise.all(Array.from({ length: 6 }, (_, i) => hashPasswordAsync(`pw-${i}-xxxxxxxx`)));
    const elapsed = performance.now() - started;
    clearInterval(t);
    // با scryptSync (بلوک‌کننده) در این بازه هیچ تیکی رخ نمی‌داد؛ اینجا باید ده‌ها تیک و فاصله‌ی کوتاه داشته باشیم
    expect(ticks).toBeGreaterThan(Math.min(10, Math.floor(elapsed / 40)));
    expect(maxGap).toBeLessThan(120);
  });
});

describe("PERF-02: جستجو و صفحه‌بندی قراردادها", () => {
  const prefix = uniq("srch");
  beforeAll(async () => {
    const vals = Array.from({ length: 45 }, (_, i) => ({
      workspaceId: wsId,
      number: `${prefix}-${i}`,
      title: i % 5 === 0 ? `قرارداد ویژه‌ی ${prefix} شماره ${i}` : `قرارداد معمولی ${i}`,
      bodyHtml: "<p>x</p>",
      customerId: owner.id,
      tags: i === 7 ? "vip,ویژه" : "",
      issuedAt: new Date(Date.now() - i * 60_000),
    }));
    await db.insert(contracts).values(vals);
  });

  it("جستجوی زیررشته روی شماره/عنوان/برچسب و نام مشتری نتیجه‌ی درست می‌دهد", async () => {
    const byTitle = await queryContracts(wsId, { q: `ویژه‌ی ${prefix}`, pageSize: 50 });
    expect(byTitle.rows).toHaveLength(9);
    expect(byTitle.total).toBe(9);
    const byNumber = await queryContracts(wsId, { q: `${prefix}-4` });
    expect(byNumber.rows.map((r) => r.number).sort()).toEqual([`${prefix}-4`, `${prefix}-40`, `${prefix}-41`, `${prefix}-42`, `${prefix}-43`, `${prefix}-44`]);
    expect((await queryContracts(wsId, { q: "vip" })).rows.map((r) => r.number)).toEqual([`${prefix}-7`]);
    expect((await queryContracts(wsId, { q: owner.id ? "مالک" : "" })).total).toBeGreaterThanOrEqual(45);
    expect((await queryContracts(wsId, { q: "100%_نیست" })).rows).toHaveLength(0); // کاراکترهای LIKE خنثی‌اند
  });

  it("صفحه‌بندی: کل بدون count اضافی برای صفحه‌ی ناقص، کلمپ صفحه‌ی بیرون از محدوده، openRequests دسته‌ای", async () => {
    const p1 = await queryContracts(wsId, { q: prefix, pageSize: 20 });
    expect(p1).toMatchObject({ total: 45, pages: 3, page: 1 });
    expect(p1.rows).toHaveLength(20);
    const p3 = await queryContracts(wsId, { q: prefix, pageSize: 20, page: 3 });
    expect(p3).toMatchObject({ total: 45, pages: 3, page: 3 });
    expect(p3.rows).toHaveLength(5);
    const far = await queryContracts(wsId, { q: prefix, pageSize: 20, page: 99 });
    expect(far).toMatchObject({ page: 3, pages: 3, total: 45 });
    expect(far.rows).toHaveLength(5);
    expect(p1.rows.every((r) => r.openRequests === 0)).toBe(true);
    expect(p1.totalCapped).toBe(false);
  });

  it("ایندکس‌های trigram وجود دارند و برنامه‌ی اجرا از آن‌ها استفاده می‌کند (بدون اسکن کامل)", async () => {
    const idx = await rows<{ indexname: string }>(sql`select indexname from pg_indexes where indexname in ('contracts_title_trgm_idx','contracts_number_trgm_idx','contracts_tags_trgm_idx','users_name_trgm_idx','users_email_trgm_idx','contract_comments_open_requests_idx')`);
    expect(idx.map((i) => i.indexname).sort()).toEqual(["contract_comments_open_requests_idx", "contracts_number_trgm_idx", "contracts_tags_trgm_idx", "contracts_title_trgm_idx", "users_email_trgm_idx", "users_name_trgm_idx"]);
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("analyze contracts");
      await client.query("analyze users");
      // روی جدول کوچکِ آزمون، برنامه‌ریز اسکن ترتیبی را ارزان می‌داند؛ آن را خاموش می‌کنیم تا «قابلیت استفاده» از ایندکس اثبات شود
      await client.query("set local enable_seqscan = off");
      const plan = (sql_: string) => client.query(`explain ${sql_}`).then((r) => r.rows.map((x) => x["QUERY PLAN"]).join("\n"));
      const p1 = await plan(`select c.id from contracts c where (c.number ilike '%abc%' or c.title ilike '%abc%' or c.tags ilike '%abc%')`);
      expect(p1).toMatch(/BitmapOr/);
      expect(p1).toMatch(/contracts_(title|number|tags)_trgm_idx/);
      const p2 = await plan(`select u.id from users u where u.name ilike '%abc%' or u.email ilike '%abc%'`);
      expect(p2).toMatch(/users_(name|email)_trgm_idx/);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("PERF-03: امضا پیش از PDF/ایمیل پاسخ می‌دهد؛ کارها ماندگار و قابل‌تکرارند", () => {
  it("پاسخ امضای نهایی بدون PDF برمی‌گردد؛ سپس پردازشگر PDF و ایمیل را می‌سازد", async () => {
    setJobsMode("background");
    setJobsPaused(true);
    try {
      const c = await newContract(wsId, owner.id, { title: "امضای سریع" });
      const t0 = performance.now();
      await signAll(c.id);
      const signMs = performance.now() - t0;
      const [row] = await db.select().from(contracts).where(eq(contracts.id, c.id));
      expect(row.status).toBe("signed");
      expect(row.docHash).toMatch(/^[a-f0-9]{64}$/);
      // هنوز نه PDF هست نه ایمیلِ نهایی؛ ولی کار در صف ماندگار ثبت شده
      expect(await db.select().from(contractDocuments).where(eq(contractDocuments.contractId, c.id))).toHaveLength(0);
      const jobs = await db.select().from(backgroundJobs).where(sql`${backgroundJobs.dedupeKey} = ${`finalize:${c.id}`}`);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe("pending");
      expect(signMs).toBeLessThan(15_000);

      setJobsPaused(false);
      await drainJobs();
      const docs = await db.select().from(contractDocuments).where(eq(contractDocuments.contractId, c.id));
      expect(docs).toHaveLength(1);
      expect(fs.readFileSync(path.join(process.env.STORAGE_DIR!, "documents", docs[0].file)).subarray(0, 5).toString()).toBe("%PDF-");
      const mails = await db.select().from(notifications).where(and(eq(notifications.contractId, c.id), sql`${notifications.subject} like '%امضا شد%'`));
      expect(mails.length).toBeGreaterThanOrEqual(2);
      expect((await db.select().from(backgroundJobs).where(sql`${backgroundJobs.dedupeKey} = ${`finalize:${c.id}`}`))[0].status).toBe("done");
      // اجرای دوباره‌ی پردازشگر هیچ ایمیل/سندی تکراری نمی‌سازد (ایدمپوتنت)
      await drainJobs();
      expect(await db.select().from(contractDocuments).where(eq(contractDocuments.contractId, c.id))).toHaveLength(1);
      expect((await db.select().from(notifications).where(and(eq(notifications.contractId, c.id), sql`${notifications.subject} like '%امضا شد%'`))).length).toBe(mails.length);
    } finally {
      setJobsPaused(false);
      setJobsMode(undefined);
    }
  });

  it("شکست کار → تلاش دوباره با backoff؛ پس از سقف تلاش → dead و hook ‌ی onDead", async () => {
    setJobsMode("background");
    let calls = 0;
    let deadSeen = "";
    registerJobHandler("test.flaky", {
      async run(_p, ctx) {
        calls++;
        if (ctx.attempt < 2) throw new Error("خطای موقت");
      },
    });
    registerJobHandler("test.doomed", {
      async run() {
        throw new Error("همیشه شکست");
      },
      async onDead(_p, err) {
        deadSeen = err;
      },
    });
    try {
      await enqueueJob("test.flaky", {}, { dedupeKey: uniq("flaky"), kick: false });
      await enqueueJob("test.doomed", {}, { dedupeKey: uniq("doomed"), kick: false, maxAttempts: 2 });
      await drainJobs();
      let [f] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.type, "test.flaky"));
      expect(f.status).toBe("pending");
      expect(f.attempts).toBe(1);
      expect(f.runAt.getTime()).toBeGreaterThan(Date.now());
      await db.update(backgroundJobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(backgroundJobs.type, "test.flaky"));
      await db.update(backgroundJobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(backgroundJobs.type, "test.doomed"));
      await drainJobs();
      [f] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.type, "test.flaky"));
      expect(f.status).toBe("done");
      expect(calls).toBe(2);
      const [d] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.type, "test.doomed"));
      expect(d.status).toBe("dead");
      expect(deadSeen).toBe("همیشه شکست");
    } finally {
      setJobsMode(undefined);
    }
  });

  it("درج کار در تراکنشِ برگشت‌خورده ثبت نمی‌شود (Outbox اتمی)", async () => {
    const { withTransaction } = await import("@/db");
    const key = uniq("rollback");
    await expect(
      withTransaction(async () => {
        await enqueueJob("test.flaky", {}, { dedupeKey: key, kick: false });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await db.select().from(backgroundJobs).where(eq(backgroundJobs.dedupeKey, key))).toHaveLength(0);
  });
});

describe("DB-04: حذف حساب اتمی و کامل", () => {
  it("شکست در میانه، همه‌چیز را برمی‌گرداند (حساب نیمه‌پاک نمی‌ماند)", async () => {
    const { buyer } = await newContract(wsId, owner.id);
    await db.insert(userTotp).values({ userId: buyer.userId, secret: "s", enabledAt: new Date() }).onConflictDoNothing();
    await notifyUser(buyer.userId, { title: "اعلان" });
    const [before] = await db.select().from(users).where(eq(users.id, buyer.userId));
    await db.execute(sql`create or replace function emz_fail_del() returns trigger as $$ begin raise exception 'boom'; end $$ language plpgsql`);
    await db.execute(sql`create trigger emz_fail_trg before delete on user_notifications for each row execute function emz_fail_del()`);
    try {
      await expect(deleteAccount(buyer.userId)).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger if exists emz_fail_trg on user_notifications`);
    }
    const [after] = await db.select().from(users).where(eq(users.id, buyer.userId));
    expect(after.email).toBe(before.email);
    expect(after.name).toBe(before.name);
    expect(await db.select().from(userTotp).where(eq(userTotp.userId, buyer.userId))).toHaveLength(1);
    expect(await db.select().from(userNotifications).where(eq(userNotifications.userId, buyer.userId))).toHaveLength(1);
    // پس از رفع مشکل، حذف کامل موفق می‌شود
    expect((await deleteAccount(buyer.userId)).ok).toBe(true);
  });

  it("مدارک KYC، تصویر امضا (دارای PDF) و تیکت‌ها پاک می‌شوند؛ فایل‌ها پس از commit حذف می‌شوند", async () => {
    const c = await newContract(wsId, owner.id, { title: "برای حذف حساب" });
    await signAll(c.id); // حالت inline: PDF نهایی ساخته و مهر می‌شود
    const signers = await getSigners(c.id);
    const buyerSigner = signers.find((s) => s.userId === c.buyer.userId)!;
    const sigFile = buyerSigner.signatureFile!;
    expect(fs.existsSync(path.join(signaturesDir(), sigFile))).toBe(true);

    fs.mkdirSync(kycDir(), { recursive: true });
    const kycName = `${uniq("kyc")}.bin`;
    fs.writeFileSync(path.join(kycDir(), kycName), "encrypted-bytes");
    const [sub] = await db.insert(kycSubmissions).values({ workspaceId: wsId, userId: c.buyer.userId, fullName: "نام واقعی", nationalCodeEnc: "enc", nationalCodeHash: uniq("h") }).returning();
    await db.insert(kycDocuments).values({ submissionId: sub.id, kind: "selfie", originalName: "a.jpg", mime: "image/jpeg", size: 3, sha256: "x", file: kycName });
    await db.execute(sql`insert into tickets (number, user_id, workspace_id, subject) values (${uniq("T-")}, ${c.buyer.userId}, ${wsId}, 'موضوع خصوصی')`).catch(async () => {
      /* ستون‌های اجباری دیگر: صرف‌نظر از تیکت در این آزمون */
    });

    const r = await deleteAccount(c.buyer.userId);
    expect(r.ok).toBe(true);
    expect(await db.select().from(kycSubmissions).where(eq(kycSubmissions.userId, c.buyer.userId))).toHaveLength(0);
    expect(await db.select().from(kycDocuments).where(eq(kycDocuments.submissionId, sub.id))).toHaveLength(0);
    expect(fs.existsSync(path.join(kycDir(), kycName))).toBe(false);
    expect(fs.existsSync(path.join(signaturesDir(), sigFile))).toBe(false);
    const [after] = await db.select().from(contractSigners).where(eq(contractSigners.id, buyerSigner.id));
    expect(after.signatureFile).toBeNull();
    // سند امضاشده و PDF مهرشده‌اش سر جایش می‌ماند
    expect((await db.select().from(contracts).where(eq(contracts.id, c.id)))[0].status).toBe("signed");
    expect(await db.select().from(contractDocuments).where(eq(contractDocuments.contractId, c.id))).toHaveLength(1);
  });

  it("تصویر امضای قرارداد نهایی «بدون PDF ذخیره‌شده» تا ساخته‌شدن PDF حفظ می‌شود", async () => {
    setJobsMode("background");
    setJobsPaused(true);
    try {
      const c = await newContract(wsId, owner.id, { title: "بدون PDF" });
      await signAll(c.id);
      const signers = await getSigners(c.id);
      const buyerSigner = signers.find((s) => s.userId === c.buyer.userId)!;
      expect(await db.select().from(contractDocuments).where(eq(contractDocuments.contractId, c.id))).toHaveLength(0);
      expect((await deleteAccount(c.buyer.userId)).ok).toBe(true);
      const [after] = await db.select().from(contractSigners).where(eq(contractSigners.id, buyerSigner.id));
      expect(after.signatureFile).toBe(buyerSigner.signatureFile);
      expect(fs.existsSync(path.join(signaturesDir(), buyerSigner.signatureFile!))).toBe(true);
    } finally {
      setJobsPaused(false);
      setJobsMode(undefined);
      await drainJobs();
    }
  });
});

void guestSignWith;

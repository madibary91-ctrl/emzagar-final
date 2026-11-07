import fs from "node:fs";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, count, eq, like, sql } from "drizzle-orm";
import { afterCommit, db, inTransaction, onRollback, outsideTransaction, withTransaction } from "@/db";
import { auditLogs, contractSigners, otpCodes, contracts, passwordResets, signingLinks, users, workspaceInvites, workspaceMembers, workspaces } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { signaturesDir } from "@/lib/storage-paths";
import { acceptInviteAction, registerAction, resetPasswordAction } from "@/modules/auth/actions";
import { createResetToken } from "@/modules/auth/tokens";
import { issueContract } from "@/modules/contracts/service";
import { createFirstAdmin } from "@/modules/install/service";
import { SCHEMA_CREATE } from "@/modules/install/schema-sql";
import { createInvite } from "@/modules/tenancy/invites";
import { createWorkspace, ensureClient } from "@/modules/tenancy/service";
import { getWallet, grantCredits } from "@/modules/wallet/service";
import { form, freshBrowser, run, uniq } from "../helpers";
import { guestSignWith, newContract, setupWorkspace } from "../flows";

/**
 * CR-01 / DB-02 / DB-03: جریان‌های چندمرحله‌ای باید اتمی باشند.
 * خطا با «تریگر دیتابیس» شبیه‌سازی می‌شود (خطای واقعی PostgreSQL در میانه‌ی کار، نه mock):
 * پس از شکست، هیچ اثر نیمه‌کاره‌ای نباید در دیتابیس (یا روی دیسک) باقی بماند و تلاش دوم باید سالم کار کند.
 */

const faults: { table: string; name: string }[] = [];
async function injectFault(table: string, when: string) {
  const name = `emz_fault_${faults.length}`;
  await db.execute(sql.raw(`create or replace function emz_fault() returns trigger language plpgsql as $$ begin raise exception 'simulated failure'; end $$`));
  await db.execute(sql.raw(`create trigger ${name} before insert or update on ${table} for each row when (${when}) execute function emz_fault()`));
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

const userByEmail = async (email: string) => (await db.select().from(users).where(eq(users.email, email)))[0];
const newUserValues = (email: string) => ({ name: "کاربر", email, mobile: "09120000001", passwordHash: hashPassword("Passw0rdX9"), role: "user" as const, emailVerifiedAt: new Date() });
const FAIL = /simulated failure/;
/** فاصله‌ی مجاز ارسال دوباره‌ی OTP برای تلاش دوم امضاکننده برداشته می‌شود */
const resetOtp = (signerId: number) => db.delete(otpCodes).where(eq(otpCodes.signerId, signerId));
/** drizzle خطای اصلی PostgreSQL را در cause می‌گذارد؛ هم پیام و هم cause بررسی می‌شود */
async function expectFault(p: Promise<unknown>) {
  const err = (await p.then(() => null, (e: unknown) => e ?? new Error("rejected"))) as { message?: string; cause?: { message?: string } } | null;
  expect(err, "عملیات باید با خطای شبیه‌سازی‌شده شکست بخورد").not.toBeNull();
  expect(`${err?.message ?? ""} ${err?.cause?.message ?? ""}`).toMatch(FAIL);
}

let owner: { id: number };
let wsId: number;
beforeAll(async () => {
  ({ owner, wsId } = await setupWorkspace("فضای اتمیک"));
});

describe("زیرساخت withTransaction (تراکنش محیطی)", () => {
  it("خطا = rollback کامل؛ موفقیت = commit", async () => {
    const bad = `${uniq("rb")}@example.com`;
    await expect(
      withTransaction(async () => {
        await db.insert(users).values(newUserValues(bad));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await userByEmail(bad)).toBeUndefined();

    const good = `${uniq("cm")}@example.com`;
    await withTransaction(async () => {
      await db.insert(users).values(newUserValues(good));
    });
    expect(await userByEmail(good)).toBeDefined();
  });

  it("db در عمق کد خودکار به تراکنش می‌پیوندد و تا commit برای بیرون نامرئی است", async () => {
    const email = `${uniq("amb")}@example.com`;
    const find = () => db.select().from(users).where(eq(users.email, email));
    let inside = 0;
    let outside = -1;
    await withTransaction(async () => {
      expect(inTransaction()).toBe(true);
      await db.insert(users).values(newUserValues(email));
      inside = (await find()).length;
      outside = (await outsideTransaction(async () => find())).length;
    });
    expect(inTransaction()).toBe(false);
    expect(inside).toBe(1);
    expect(outside).toBe(0);
    expect((await find()).length).toBe(1);
  });

  it("afterCommit فقط پس از commit اجرا می‌شود و onRollback فقط هنگام برگشت", async () => {
    const events: string[] = [];
    await withTransaction(async () => {
      await afterCommit(() => void events.push("commit-A"));
      onRollback(() => void events.push("rollback-A"));
      expect(events).toEqual([]); // هنوز هیچ اثر جانبی اجرا نشده
    });
    await withTransaction(async () => {
      await afterCommit(() => void events.push("commit-B"));
      onRollback(() => void events.push("rollback-B"));
      throw new Error("x");
    }).catch(() => undefined);
    expect(events).toEqual(["commit-A", "rollback-B"]);
    // خارج از تراکنش فوراً اجرا می‌شود
    await afterCommit(() => void events.push("now"));
    expect(events.at(-1)).toBe("now");
  });

  it("تودرتو = SAVEPOINT: شکست داخلی فقط خودش را برمی‌گرداند و اثر جانبی‌اش دور ریخته می‌شود", async () => {
    const a = `${uniq("na")}@example.com`;
    const b = `${uniq("nb")}@example.com`;
    const events: string[] = [];
    await withTransaction(async () => {
      await db.insert(users).values(newUserValues(a));
      await withTransaction(async () => {
        await db.insert(users).values(newUserValues(b));
        await afterCommit(() => void events.push("inner"));
        throw new Error("inner");
      }).catch(() => undefined);
    });
    expect(await userByEmail(a)).toBeDefined();
    expect(await userByEmail(b)).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("خطای SQL بلعیده‌شده، موفقیت دروغین نمی‌سازد (سد تراکنش ناقص)", async () => {
    const email = `${uniq("sw")}@example.com`;
    await expect(
      withTransaction(async () => {
        await db.insert(users).values(newUserValues(email));
        try {
          await db.execute(sql`select * from table_that_does_not_exist`);
        } catch {
          /* بلعیده شد */
        }
      }),
    ).rejects.toThrow();
    expect(await userByEmail(email)).toBeUndefined();
  });

  it("ادامه‌ی ناهمگام جامانده پس از پایان تراکنش از اتصال بسته‌شده استفاده نمی‌کند", async () => {
    let leaked: (() => Promise<unknown>) | undefined;
    await withTransaction(async () => {
      leaked = () => db.execute(sql`select 1 as ok`);
    });
    await expect(leaked!()).resolves.toBeDefined();
  });
});

describe("CR-01: امضای نهایی اتمیک است", () => {
  const sigFiles = (contractId: number, signerId: number) => fs.readdirSync(signaturesDir()).filter((f) => f.startsWith(`c${contractId}-s${signerId}-`));
  const auditCount = async (contractId: number, action: string) =>
    (await db.select({ n: count() }).from(auditLogs).where(and(eq(auditLogs.contractId, contractId), eq(auditLogs.action, action))))[0].n;

  it("خطا هنگام نهایی‌سازی: امضای آخرین نفر هم برمی‌گردد (نه «امضاشده» با قرارداد sent) و تلاش دوم کامل می‌شود", async () => {
    const { id, signers } = await newContract(wsId, owner.id);
    const [first, last] = signers;
    expect((await guestSignWith(first.id)).result.ok).toBe(true);

    // شکست در آخرین گام: لاگ «contract.completed» (پس از به‌روزرسانی وضعیت قرارداد)
    await injectFault("audit_logs", `NEW.contract_id = ${id} AND NEW.action = 'contract.completed'`);
    await expectFault(guestSignWith(last.id));

    const [lastRow] = await db.select().from(contractSigners).where(eq(contractSigners.id, last.id));
    expect(lastRow.status).toBe("pending");
    expect(lastRow.signedAt).toBeNull();
    expect(lastRow.signatureFile).toBeNull();
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.status).toBe("sent");
    expect(c.docHash).toBeNull();
    expect(c.signedAt).toBeNull();
    expect(await auditCount(id, "contract.signed")).toBe(1); // فقط نفر اول
    expect(await auditCount(id, "contract.completed")).toBe(0);
    expect(sigFiles(id, last.id)).toEqual([]); // فایل امضای بی‌صاحب پاک شده است

    await clearFaults();
    await resetOtp(last.id);
    const retry = await guestSignWith(last.id);
    expect(retry.result.ok, retry.result.error).toBe(true);
    expect(retry.result.completed).toBe(true);
    const [done] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(done.status).toBe("signed");
    expect(done.docHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await auditCount(id, "contract.completed")).toBe(1);
    expect((await db.select().from(contractSigners).where(eq(contractSigners.contractId, id))).every((s) => s.status === "signed")).toBe(true);
  });

  it("خطا در میانه‌ی ثبت امضا: وضعیت امضاکننده و «مصرف لینک» هر دو برمی‌گردند", async () => {
    const { id, signers } = await newContract(wsId, owner.id);
    const [first] = signers;
    await injectFault("audit_logs", `NEW.contract_id = ${id} AND NEW.action = 'contract.signed'`);
    await expectFault(guestSignWith(first.id));

    const [row] = await db.select().from(contractSigners).where(eq(contractSigners.id, first.id));
    expect(row.status).toBe("pending");
    const links = await db.select().from(signingLinks).where(eq(signingLinks.signerId, first.id));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.usedAt === null)).toBe(true);
    expect(sigFiles(id, first.id)).toEqual([]);

    await clearFaults();
    await resetOtp(first.id);
    expect((await guestSignWith(first.id)).result.ok).toBe(true);
  });
});

describe("DB-02: صدور قرارداد تراکنشی است", () => {
  it("خطا در میانه‌ی صدور: هیچ ردیف TMP/نیمه‌کاره‌ای (قرارداد، امضاکننده، نسخه) باقی نمی‌ماند", async () => {
    const client = await ensureClient(wsId, { name: "مشتری", email: `${uniq("i")}@example.com`, mobile: "09121110003" });
    const before = (await db.select({ n: count() }).from(contracts).where(eq(contracts.workspaceId, wsId)))[0].n;

    // شکست در آخرین گام صدور (لاگ ممیزی) — بعد از درج قرارداد، متن، نسخه و امضاکنندگان
    await injectFault("audit_logs", `NEW.action = 'contract.issued'`);
    await expectFault(issueContract({ workspaceId: wsId, title: "قرارداد ناموفق", bodyHtml: "<p>متن آزمایشی قرارداد ناموفق برای آزمون.</p>", customerId: client.userId, createdBy: owner.id }));

    expect((await db.select({ n: count() }).from(contracts).where(eq(contracts.workspaceId, wsId)))[0].n).toBe(before);
    expect((await db.select({ n: count() }).from(contracts).where(and(eq(contracts.workspaceId, wsId), like(contracts.number, "TMP-%"))))[0].n).toBe(0);
    expect((await db.select({ n: count() }).from(contractSigners).where(eq(contractSigners.userId, client.userId)))[0].n).toBe(0);

    await clearFaults();
    const id = await issueContract({ workspaceId: wsId, title: "قرارداد سالم", bodyHtml: "<p>متن آزمایشی قرارداد سالم برای آزمون.</p>", customerId: client.userId, createdBy: owner.id });
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.status).toBe("sent");
    expect(c.number).toMatch(/^AMZ-\d{4}-\d{5}$/);
    expect(c.bodyHtml).toContain("قرارداد سالم");
  });

  it("اعتبار کیف پولِ مصرف‌شده با شکست صدور خودکار برمی‌گردد (دقیقاً یک‌بار) و صدور سالم آن را مصرف می‌کند", async () => {
    const freeWs = await createWorkspace(owner.id, "طرح رایگان");
    const client = await ensureClient(freeWs, { name: "مشتری", email: `${uniq("f")}@example.com`, mobile: "09121110004" });
    const issue = (title: string) => issueContract({ workspaceId: freeWs, title, bodyHtml: "<p>متن آزمایشی برای پر کردن سقف ماهانه‌ی طرح رایگان.</p>", customerId: client.userId, createdBy: owner.id });
    for (let i = 0; i < 10; i++) await issue(`پرکننده ${i}`); // سقف ماهانه‌ی طرح رایگان = ۱۰
    await grantCredits(freeWs, 2, { kind: "gift", ref: `t:${uniq("g")}`, description: "آزمون" });
    expect((await getWallet(freeWs)).credits).toBe(2);

    await injectFault("audit_logs", `NEW.action = 'contract.issued'`);
    await expectFault(issue("بالاتر از سقف ناموفق"));
    expect((await getWallet(freeWs)).credits).toBe(2); // نه ۱ (مصرف‌شده) و نه ۳ (بازگشت مضاعف)

    await clearFaults();
    await issue("بالاتر از سقف موفق");
    expect((await getWallet(freeWs)).credits).toBe(1);
  });

  it("شکست اعلان پس از commit، قرارداد صادرشده را باطل نمی‌کند و در لاگ ثبت می‌شود", async () => {
    const client = await ensureClient(wsId, { name: "مشتری", email: `${uniq("a")}@example.com`, mobile: "09121110005" });
    await injectFault("short_links", "true");
    const id = await issueContract({ workspaceId: wsId, title: "اعلان ناموفق", bodyHtml: "<p>متن آزمایشی قرارداد با اعلان ناموفق.</p>", customerId: client.userId, createdBy: owner.id });
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.status).toBe("sent");
    expect(c.number).toMatch(/^AMZ-/);
    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.contractId, id), eq(auditLogs.action, "contract.announce_failed")));
    expect(logs.length).toBe(1);
  });
});

describe("DB-03: جریان‌های چندمرحله‌ای تراکنشی‌اند", () => {
  it("createWorkspace: شکست در میانه، فضای کاری/عضویت یتیم نمی‌گذارد", async () => {
    const counts = async () => ({
      ws: (await db.select({ n: count() }).from(workspaces).where(eq(workspaces.ownerId, owner.id)))[0].n,
      members: (await db.select({ n: count() }).from(workspaceMembers).where(eq(workspaceMembers.userId, owner.id)))[0].n,
    });
    const before = await counts();
    await injectFault("templates", "true"); // آخرین گام createWorkspace
    await expectFault(createWorkspace(owner.id, "ناقص"));
    expect(await counts()).toEqual(before);
  });

  it("ثبت‌نام: شکست ساخت workspace = کاربر هم ساخته نمی‌شود؛ تلاش دوم با همان ایمیل موفق است", async () => {
    const email = `${uniq("reg")}@example.com`;
    const reg = () => run(() => registerAction({}, form({ name: "کاربر آزمون", email, mobile: "09123456789", password: "Passw0rdX9", workspaceName: "کسب‌وکار آزمون" })));

    await injectFault("templates", "true");
    await expectFault(reg());
    expect(await userByEmail(email)).toBeUndefined(); // کاربرِ «بدون workspace» وجود ندارد

    await clearFaults();
    freshBrowser();
    const ok = await reg();
    expect(ok.redirect).toMatch(/^\/verify-email/);
    const u = await userByEmail(email);
    expect(u).toBeDefined();
    const [m] = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, u.id));
    expect(m?.role).toBe("owner");
  });

  it("بازیابی رمز: شکست در میانه، توکن را نمی‌سوزاند و رمز را تغییر نمی‌دهد", async () => {
    const [u] = await db.insert(users).values(newUserValues(`${uniq("rp")}@example.com`)).returning();
    const token = await createResetToken(u.id, 2);
    const attempt = () => run(() => resetPasswordAction({}, form({ token, password: "NewPassw0rd1", confirm: "NewPassw0rd1" })));

    await injectFault("audit_logs", `NEW.user_id = ${u.id} AND NEW.action = 'auth.password_reset'`);
    await expectFault(attempt());
    const [row] = await db.select().from(passwordResets).where(eq(passwordResets.userId, u.id));
    expect(row.usedAt).toBeNull(); // توکن هنوز قابل استفاده است
    expect((await db.select().from(users).where(eq(users.id, u.id)))[0].passwordHash).toBe(u.passwordHash);

    await clearFaults();
    const ok = await attempt();
    expect(ok.redirect).toBe("/login?reset=1");
    expect((await db.select().from(users).where(eq(users.id, u.id)))[0].passwordHash).not.toBe(u.passwordHash);
    expect((await db.select().from(passwordResets).where(eq(passwordResets.userId, u.id)))[0].usedAt).not.toBeNull();
  });

  it("پذیرش دعوت: شکست در میانه، حساب نمی‌سازد و دعوت‌نامه را نمی‌سوزاند", async () => {
    const email = `${uniq("inv")}@example.com`;
    const token = await createInvite(wsId, email, "member", owner.id);
    const attempt = () => run(() => acceptInviteAction({}, form({ token, name: "عضو جدید", mobile: "09125550000", password: "Passw0rdX9" })));

    await injectFault("audit_logs", `NEW.action = 'member.joined'`);
    await expectFault(attempt());
    expect(await userByEmail(email)).toBeUndefined();
    expect((await db.select().from(workspaceInvites).where(eq(workspaceInvites.email, email)))[0].acceptedAt).toBeNull();

    await clearFaults();
    freshBrowser();
    const ok = await attempt();
    expect(ok.redirect).toBe("/admin");
    const u = await userByEmail(email);
    expect(u).toBeDefined();
    const [m] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.userId, u.id), eq(workspaceMembers.workspaceId, wsId)));
    expect(m?.role).toBe("member");
    expect((await db.select().from(workspaceInvites).where(eq(workspaceInvites.email, email)))[0].acceptedAt).not.toBeNull();
  });
});

describe("DB-03: نصب (createFirstAdmin) روی دیتابیس تازه", () => {
  const ISO = "emz_test_install_iso";
  const base = new URL(process.env.TEST_DATABASE_URL!);
  const urlOf = (name: string) => {
    const u = new URL(base.toString());
    u.pathname = `/${name}`;
    return u.toString();
  };
  const savedUrl = process.env.DATABASE_URL;
  let iso: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: urlOf("postgres"), max: 1 });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${ISO}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${ISO}"`);
    } finally {
      await admin.end();
    }
    iso = new Pool({ connectionString: urlOf(ISO), max: 2 });
    for (const st of SCHEMA_CREATE) await iso.query(st);
    process.env.DATABASE_URL = urlOf(ISO); // برنامه روی دیتابیس خالیِ جدا کار می‌کند
  });
  afterAll(async () => {
    process.env.DATABASE_URL = savedUrl;
    await db.execute(sql`select 1`); // اتصال برنامه به دیتابیس آزمون برمی‌گردد
    await iso.end();
    const admin = new Pool({ connectionString: urlOf("postgres"), max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS "${ISO}" WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  });

  const n = async (table: string) => Number((await iso.query(`select count(*)::int as n from ${table}`)).rows[0].n);
  const input = { siteName: "سایت نصب", name: "مدیر", email: "admin@example.com", mobile: "09120000000", password: "Passw0rdX9" };

  it("شکست ساخت workspace/تنظیمات = مدیر بدون workspace ساخته نمی‌شود و نصب قفل نمی‌ماند؛ تلاش دوم موفق است", async () => {
    await iso.query(`create or replace function emz_fault() returns trigger language plpgsql as $$ begin raise exception 'simulated failure'; end $$`);
    await iso.query(`create trigger emz_iso_fault before insert on workspace_settings for each row when (NEW.key = 'admin_email') execute function emz_fault()`);

    await expectFault(createFirstAdmin(input));
    expect(await n("users")).toBe(0);
    expect(await n("workspaces")).toBe(0);
    expect(await n("workspace_members")).toBe(0);
    expect(await n("templates")).toBe(0);

    await iso.query(`drop trigger emz_iso_fault on workspace_settings`);
    const created = await createFirstAdmin(input);
    expect(created).not.toBeNull();
    expect(await n("users")).toBe(1);
    expect(await n("workspaces")).toBe(1);
    expect((await iso.query(`select role from workspace_members where user_id = $1`, [created!.userId])).rows[0].role).toBe("owner");
    expect(await n("landing_versions")).toBe(1); // صفحه‌ی فرود پیش‌فرض هم در همان نصب ساخته شده
    // نصب دوباره (کاربر موجود است) چیزی نمی‌سازد
    expect(await createFirstAdmin({ ...input, email: "other@example.com" })).toBeNull();
    expect(await n("users")).toBe(1);
  });
});

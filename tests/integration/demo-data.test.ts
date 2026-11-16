import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, contractSigners, contracts, demoRecords, tickets, users, workspaceMembers } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { createWorkspace } from "@/modules/tenancy/service";
import { clearDemoData, demoStatus, seedDemoData } from "@/modules/demo/service";
import { DEMO_CONTRACTS, DEMO_PEOPLE, DEMO_TICKETS } from "@/modules/demo/data";
import { getUsage } from "@/modules/billing/service";
import { docFingerprint } from "@/modules/signing/fingerprint";
import { issueContract } from "@/modules/contracts/service";
import { ensureClient } from "@/modules/tenancy/service";
import { uniq } from "../helpers";

let ws = 0;
let admin = 0;
beforeAll(async () => {
  const [u] = await db.insert(users).values({ name: "مدیر", email: `${uniq("demo")}@example.com`, passwordHash: hashPassword("x"), role: "admin", emailVerifiedAt: new Date() }).returning();
  admin = u.id;
  ws = await createWorkspace(u.id, "فضای دمو");
});

const count = async (t: typeof contracts | typeof tickets, col: unknown) => (await db.select({ n: sql<number>`count(*)::int` }).from(t).where(eq(col as never, ws)))[0].n;

describe("داده‌های نمونه", () => {
  it("ساخت: قرارداد، کاربر، تیکت و لاگ واقع‌گرایانه با ثبت در demo_records", async () => {
    const st = await seedDemoData({ workspaceId: ws, actorId: admin });
    expect(st.seeded).toBe(true);
    expect(st.counts.contracts).toBe(DEMO_CONTRACTS.length);
    expect(st.counts.users).toBe(DEMO_PEOPLE.length);
    expect(st.counts.tickets).toBe(DEMO_TICKETS.length);
    expect(st.counts.logs).toBeGreaterThan(30);
    const rows = await db.select().from(contracts).where(eq(contracts.workspaceId, ws));
    const statuses = new Set(rows.map((r) => r.status));
    for (const s of ["signed", "sent", "draft", "rejected", "expired", "cancelled"]) expect(statuses.has(s)).toBe(true);
    expect(new Set(rows.map((r) => r.number)).size).toBe(rows.length);
    expect(rows.every((r) => /^AMZ-\d{4}-\d{5}$/.test(r.number))).toBe(true);
  });

  it("قرارداد امضاشده‌ی نمونه اثر انگشت معتبر دارد (استعلام اصالت)", async () => {
    const signed = (await db.select().from(contracts).where(and(eq(contracts.workspaceId, ws), eq(contracts.status, "signed"))))[0];
    const signers = await db.select().from(contractSigners).where(eq(contractSigners.contractId, signed.id)).orderBy(contractSigners.position);
    expect(signers.every((s) => s.status === "signed")).toBe(true);
    expect(docFingerprint(signed.bodyHtml, signers.map((s) => ({ userId: s.userId, signedAt: s.signedAt, ip: s.ip })))).toBe(signed.docHash);
    expect(signed.bodyHtml).not.toMatch(/\[[A-Z_]+\]/); // متغیری باقی نمانده
  });

  it("سهمیه‌ی ماهانه‌ی طرح مصرف نمی‌شود و ساخت دوباره ممنوع است", async () => {
    expect((await getUsage(ws)).contracts).toBe(0);
    await expect(seedDemoData({ workspaceId: ws, actorId: admin })).rejects.toThrow(/قبلاً/);
    expect((await demoStatus(ws)).counts.contracts).toBe(DEMO_CONTRACTS.length);
  });

  it("پاک‌سازی: فقط داده‌ی نمونه حذف می‌شود و داده‌ی واقعی دست‌نخورده می‌ماند", async () => {
    const c = await ensureClient(ws, { name: "مشتری واقعی", email: `${uniq("real")}@example.com`, mobile: "09120000099" });
    const realId = await issueContract({ workspaceId: ws, title: "قرارداد واقعی", bodyHtml: "<p>متن واقعی [USER_NAME]</p>", customerId: c.userId, createdBy: admin });
    // یک قرارداد واقعی برای «یکی از کاربران نمونه» هم صادر می‌شود: آن کاربر نباید حذف شود
    const demoUserId = (await db.select().from(demoRecords).where(and(eq(demoRecords.workspaceId, ws), eq(demoRecords.entity, "user"))))[0].entityId;
    const keptContract = await issueContract({ workspaceId: ws, title: "قرارداد واقعی با مشتری نمونه", bodyHtml: "<p>x</p>", customerId: demoUserId, createdBy: admin });

    const r = await clearDemoData({ workspaceId: ws, actorId: admin });
    expect(r.seeded).toBe(false);
    expect(r.kept).toBe(1);
    expect(await count(contracts, contracts.workspaceId)).toBe(2);
    expect(await count(tickets, tickets.workspaceId)).toBe(0);
    const left = await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.workspaceId, ws));
    expect(left.map((x) => x.id).sort()).toEqual([realId, keptContract].sort());
    expect((await db.select().from(users).where(eq(users.id, demoUserId))).length).toBe(1);
    const members = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ws), eq(workspaceMembers.role, "client")));
    expect(members.length).toBe(2); // مشتری واقعی + کاربر نگه‌داشته‌شده
    // لاگ قراردادهای نمونه رفته؛ لاگ قرارداد واقعی مانده
    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, ws), inArray(auditLogs.contractId, [realId, keptContract])));
    expect(logs.length).toBeGreaterThan(0);
  });

  it("پس از پاک‌سازی می‌توان دوباره ساخت (چرخه‌ی کامل)", async () => {
    const st = await seedDemoData({ workspaceId: ws, actorId: admin });
    expect(st.seeded).toBe(true);
    const r = await clearDemoData({ workspaceId: ws, actorId: admin });
    expect(r.seeded).toBe(false);
    expect(r.counts.contracts).toBe(0);
  });
});

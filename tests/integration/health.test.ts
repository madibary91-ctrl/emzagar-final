import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { ALL_CHECKS, computeReadiness, getHistory, getIncidents, runCheck, runChecks } from "@/modules/health/service";
import { explainNetError, probeSocket } from "@/modules/health/probe";
import type { CheckResult } from "@/modules/health/types";

const ctx = { workspaceId: 0, origin: "http://localhost:3000" };
const fake = (p: Partial<CheckResult>): CheckResult => ({ id: "x", group: "core", label: "x", status: "ok", summary: "", latencyMs: 1, checkedAt: new Date().toISOString(), deep: false, metrics: [], steps: [], hints: [], weight: 1, blocker: false, deepAvailable: false, ...p });

describe("داشبورد سلامت سیستم", () => {
  it("همه‌ی بررسی‌ها نتیجه‌ی ساختاریافته می‌دهند و هیچ‌کدام نمی‌ترکند", async () => {
    const results = await runChecks(ctx, { force: true, record: false });
    expect(results).toHaveLength(ALL_CHECKS.length);
    for (const r of results) {
      expect(["ok", "warn", "fail", "unconfigured"]).toContain(r.status);
      expect(r.summary.length).toBeGreaterThan(0);
      expect(r.label.length).toBeGreaterThan(0);
    }
    expect(results.find((r) => r.id === "database")?.status).toBe("ok");
    // هیچ اعتبارنامه‌ای در خروجی نیست
    expect(JSON.stringify(results)).not.toMatch(/postgres:postgres@/);
  });

  it("نمونه و رخداد ثبت می‌شود و پس از بازیابی بسته می‌شود", async () => {
    const def = ALL_CHECKS.find((c) => c.id === "database")!;
    await db.execute(sql`delete from health_incidents where check_id = 'database'`);
    await runCheck(def, ctx, { force: true, record: true });
    const hist = await getHistory(["database"]);
    expect(hist.database.samples.length).toBeGreaterThan(0);
    expect(hist.database.uptime24h).toBe(100);
    // رخداد دستی باز → اجرای سالم آن را می‌بندد
    await db.execute(sql`insert into health_incidents (check_id, label, severity, message) values ('database', 'دیتابیس', 'fail', 'test')`);
    await runCheck(def, ctx, { force: true, record: true });
    const open = (await getIncidents()).filter((i) => i.checkId === "database" && !i.resolvedAt);
    expect(open).toHaveLength(0);
  });

  it("تست عمیق دیتابیس در تراکنشِ برگردانده‌شده می‌نویسد (ردی نمی‌ماند)", async () => {
    const before = ((await db.execute(sql`select count(*)::int as n from health_checks where check_id = '__probe__'`)).rows[0] as { n: number }).n;
    const r = await runCheck(ALL_CHECKS.find((c) => c.id === "database")!, ctx, { deep: true, force: true, record: false });
    expect(r.deep).toBe(true);
    expect(r.steps.some((s) => s.name === "نوشتن/خواندن" && s.ok)).toBe(true);
    const after = ((await db.execute(sql`select count(*)::int as n from health_checks where check_id = '__probe__'`)).rows[0] as { n: number }).n;
    expect(after).toBe(before);
  });

  it("امتیاز آمادگی: مانع حیاتی ← «آماده نیست»؛ همه سالم ← «آماده»", () => {
    const bad = computeReadiness([fake({ id: "database", weight: 3, status: "fail", blocker: true }), fake({ id: "a", weight: 1 })]);
    expect(bad.verdict).toBe("not_ready");
    expect(bad.blockers.map((b) => b.id)).toEqual(["database"]);
    const good = computeReadiness([fake({ weight: 3 }), fake({ id: "b", weight: 2 }), fake({ id: "c", weight: 0, status: "unconfigured" })]);
    expect(good.score).toBe(100);
    expect(good.verdict).toBe("ready");
  });

  it("عیب‌یابی شبکه: پورت بسته و خطاهای فارسی", async () => {
    const r = await probeSocket("127.0.0.1", 1, { timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)?.detail).toContain("اتصال رد شد");
    expect(explainNetError({ code: "ENOTFOUND" })).toContain("DNS");
    expect(explainNetError({ code: "CERT_HAS_EXPIRED" })).toContain("منقضی");
  });
});

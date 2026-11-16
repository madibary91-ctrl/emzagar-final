import { describe, expect, it } from "vitest";
import { computeDepth, isEmail, normEmail, parseFeatures, sanitizeFeatures } from "@/modules/hub/service";

const conn = { verified: true, syncEnabled: true };

describe("عمق یکپارچگی (Business Hub)", () => {
  it("ورودی نامعتبر یا مخرب به مقادیر امن تبدیل می‌شود", () => {
    const f = sanitizeFeatures({ gates: -5, productContracts: "12", roles: "yes", badge: 0, gateChecks: 1e15, evil: "x" });
    expect(f.gates).toBe(0);
    expect(f.productContracts).toBe(12);
    expect(f.roles).toBe(true);
    expect(f.badge).toBe(false);
    expect(f.gateChecks).toBe(1e9);
    expect("evil" in f).toBe(false);
    expect(parseFeatures("not json").gates).toBe(0);
  });

  it("سایت تازه‌وصل‌شده امتیاز پایین دارد و گام بعدی پیشنهاد می‌شود", () => {
    const d = computeDepth(sanitizeFeatures({ wcActive: true }), conn);
    expect(d.score).toBeLessThan(25);
    expect(d.levelIndex).toBe(0);
    expect(d.next?.key).toBeTruthy();
  });

  it("سایت کاملاً یکپارچه به سطح «هسته‌ی کسب‌وکار» می‌رسد", () => {
    const d = computeDepth(
      sanitizeFeatures({ wcActive: true, gates: 3, productContracts: 4, orderAutomation: true, roles: true, badge: true, digest: true, adminBar: true, widget: true, portal: true, syncOrders: true, gateChecks: 20, gateAllowed: 9, workspaceUsed: true, automations: 2, forms: 1, live: true, actions: 12 }),
      conn,
    );
    expect(d.score).toBe(100);
    expect(d.level).toBe("هسته‌ی کسب‌وکار");
    expect(d.next).toBeNull();
  });

  it("ویژگی‌های مرکز فرماندهی کامل (میز کار، اتوماسیون، فرم‌ها) در امتیاز اثر دارند", () => {
    const base = computeDepth(sanitizeFeatures({ wcActive: false, gates: 1 }), conn).score;
    const more = computeDepth(sanitizeFeatures({ wcActive: false, gates: 1, automations: 3, workspaceUsed: true, forms: 2, live: true }), conn).score;
    expect(more).toBeGreaterThan(base);
    expect(sanitizeFeatures({ automations: 99999, actions: -3 }).automations).toBe(500);
    expect(sanitizeFeatures({ actions: -3 }).actions).toBe(0);
  });

  it("گام‌های ویژه‌ی ووکامرس برای سایت بدون ووکامرس محاسبه نمی‌شود", () => {
    const d = computeDepth(sanitizeFeatures({ wcActive: false }), conn);
    expect(d.steps.find((s) => s.key === "products")).toBeUndefined();
    expect(d.steps.find((s) => s.key === "orders")).toBeUndefined();
  });

  it("ایمیل نرمال‌سازی و اعتبارسنجی می‌شود", () => {
    expect(normEmail("  Ali@Example.COM ")).toBe("ali@example.com");
    expect(isEmail("ali@example.com")).toBe(true);
    expect(isEmail("not-an-email")).toBe(false);
  });
});

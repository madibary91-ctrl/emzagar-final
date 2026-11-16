import { afterAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "@/db";
import { subscriptionPlans } from "@/db/schema";
import { createPlan, listAllPlans, updatePlan } from "@/modules/billing/catalog";
import type { PlanInput } from "@/modules/billing/plans";
import { assignPlanAction, createPlanAction, deletePlanAction, setDefaultPlanAction, updatePlanAction } from "@/modules/billing/plan-actions";
import { getPlanById } from "@/modules/billing/catalog";
import { getSubscription } from "@/modules/billing/subscription";
import { form, run, uniq } from "../helpers";
import { users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { createWorkspace } from "@/modules/tenancy/service";

// vitest در این پروژه JSX را با تبدیل کلاسیک (React.createElement) کامپایل می‌کند
(globalThis as unknown as { React: typeof React }).React = React;

// صفحه‌ی مدیر کل را بدون Shell/احراز هویت رندر می‌کنیم تا ساختار فرم‌ها و داده‌ی پویا بررسی شود
vi.mock("@/components/Shell", () => ({ default: ({ children }: { children: unknown }) => children }));
const adminRef = vi.hoisted(() => ({ id: null as number | null }));
vi.mock("@/modules/platform/admin", () => ({ requirePlatformAdmin: async () => ({ id: adminRef.id, role: "admin", email: "a@b.c", name: "admin" }), isPlatformAdmin: () => true }));
vi.mock("@/modules/auth/session", () => ({ getCurrentUser: async () => null }));
vi.mock("@/modules/branding/service", () => ({ getBranding: async () => ({ name: "تست", logoUrl: "", tagline: "" }) }));

const input = (o: Partial<PlanInput>): PlanInput => ({ id: "ui-plan", name: "طرح رابط", tagline: "", priceToman: 123_000, contractsPerMonth: -1, members: 7, aiPerDay: 3, features: ["ویژگی اختصاصی"], durations: { 2: 5, 24: 40 }, highlight: false, isPublic: true, isActive: true, isRewardPlan: false, sortOrder: 5, ...o });

describe("رابط مدیریت و نمایش عمومی طرح‌ها", () => {
  afterAll(async () => {
    await db.delete(subscriptionPlans);
    await listAllPlans();
  });

  it("صفحه‌ی مدیر کل همه‌ی طرح‌ها و فرم ساخت را نشان می‌دهد و مقدارها از دیتابیس می‌آید", async () => {
    await listAllPlans();
    await createPlan(input({}));
    const { default: Page } = await import("@/app/platform/plans/page");
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ saved: "created" }) }));
    for (const name of ["رایگان", "حرفه‌ای", "سازمانی", "طرح رابط"]) expect(html).toContain(name);
    expect(html).toContain('value="123000"');
    expect(html).toContain("2:5, 24:40");
    expect(html).toContain("ویژگی اختصاصی");
    expect(html).toContain("ساخت طرح جدید");
    expect(html).toContain("اختصاص دستی طرح");
    expect(html).toContain("پیش‌فرض"); // نشان طرح پیش‌فرض
  });

  it("صفحه‌ی عمومی تعرفه طرح‌های عمومی را از دیتابیس نشان می‌دهد؛ طرح خصوصی/بایگانی نمایش داده نمی‌شود", async () => {
    await createPlan(input({ id: "secret", name: "طرح مخفی", isPublic: false }));
    await createPlan(input({ id: "old", name: "طرح قدیمی", isActive: false }));
    const { default: Pricing } = await import("@/app/pricing/page");
    let html = renderToStaticMarkup(await Pricing());
    expect(html).toContain("طرح رابط");
    expect(html).toContain("ویژگی اختصاصی");
    expect(html).not.toContain("طرح مخفی");
    expect(html).not.toContain("طرح قدیمی");
    // تغییر قیمت توسط مدیر بدون دست‌زدن به کد، بلافاصله روی صفحه می‌آید
    await updatePlan("ui-plan", input({ priceToman: 999_000 }));
    html = renderToStaticMarkup(await Pricing());
    expect(html).toContain((999_000).toLocaleString("fa-IR"));
  });

  it("اکشن‌های مدیر کل: ساخت، ویرایش، پیش‌فرض، اختصاص و حذف با اعتبارسنجی سمت سرور", async () => {
    const [admin] = await db.insert(users).values({ name: "مدیر", email: `${uniq("adm")}@example.com`, mobile: "09140000002", passwordHash: hashPassword("Adm12345xy"), role: "admin", emailVerifiedAt: new Date() }).returning();
    adminRef.id = admin.id;
    const f = { name: "اکشن", priceToman: "۲۰۰٬۰۰۰", contractsPerMonth: "50", members: "4", aiPerDay: "9", durations: "1:0, 6:15", features: "الف\nب", isPublic: "on", isActive: "on" };
    expect((await run(() => createPlanAction(form({ ...f, id: "act-plan" })))).redirect).toBe("/platform/plans?saved=created&plan=act-plan");
    expect((await getPlanById("act-plan"))?.priceToman).toBe(200_000);
    // ورودی بد → خطا و بدون تغییر
    expect((await run(() => createPlanAction(form({ ...f, id: "BAD ID" })))).redirect).toMatch(/error=/);
    expect((await run(() => createPlanAction(form({ ...f, id: "act-plan" })))).redirect).toMatch(/error=/);
    expect((await run(() => updatePlanAction(form({ ...f, id: "act-plan", priceToman: "300000", contractsUnlimited: "on" })))).redirect).toContain("saved=updated");
    const p = await getPlanById("act-plan");
    expect(p).toMatchObject({ priceToman: 300_000, contractsPerMonth: -1, durations: { 1: 0, 6: 15 }, features: ["الف", "ب"] });

    const [u] = await db.insert(users).values({ name: "ع", email: `${uniq("ac")}@example.com`, mobile: "09140000001", passwordHash: hashPassword("Act12345xy"), emailVerifiedAt: new Date() }).returning();
    const ws = await createWorkspace(u.id, "فضای اکشن");
    expect((await run(() => assignPlanAction(form({ workspaceId: String(ws), plan: "act-plan", months: "2", intent: "assign" })))).redirect).toContain("saved=assigned");
    expect((await getSubscription(ws)).planId).toBe("act-plan");
    expect((await run(() => assignPlanAction(form({ workspaceId: "99999999", plan: "act-plan", months: "2", intent: "assign" })))).redirect).toMatch(/error=/);
    expect((await run(() => assignPlanAction(form({ workspaceId: String(ws), intent: "revoke" })))).redirect).toContain("saved=revoked");
    expect((await getSubscription(ws)).planId).toBe("free");

    expect((await run(() => setDefaultPlanAction(form({ id: "act-plan" })))).redirect).toMatch(/error=/); // قیمت‌دار
    expect((await run(() => deletePlanAction(form({ id: "free" })))).redirect).toMatch(/error=/);
    // با اشتراکِ فعال، حذف = بایگانی (مشترک حفظ می‌شود)
    expect((await run(() => assignPlanAction(form({ workspaceId: String(ws), plan: "act-plan", months: "1", intent: "assign" })))).redirect).toContain("saved=assigned");
    expect((await run(() => deletePlanAction(form({ id: "act-plan" })))).redirect).toBe("/platform/plans?saved=archived");
    expect((await getPlanById("act-plan"))?.isActive).toBe(false);
    expect((await getSubscription(ws)).planId).toBe("act-plan");
    // پس از لغو اشتراک، طرح بایگانی‌شده‌ی بی‌سابقه کاملاً حذف می‌شود
    await run(() => assignPlanAction(form({ workspaceId: String(ws), intent: "revoke" })));
    expect((await run(() => deletePlanAction(form({ id: "act-plan" })))).redirect).toBe("/platform/plans?saved=deleted");
  });
});

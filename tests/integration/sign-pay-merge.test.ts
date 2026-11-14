import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contractInstallments, contracts, mergeRows, templates } from "@/db/schema";
import { GET as billingCallback } from "@/app/api/billing/callback/[gateway]/route";
import { buildSchedule } from "@/modules/contract-pay/schedule";
import { insertPlan, listInstallments, markManualPaid, receivables, runInstallmentReminders, setPlan, startInstallmentPayment, PayError } from "@/modules/contract-pay/service";
import { issueContract } from "@/modules/contracts/service";
import { ensureGuestSigner } from "@/modules/guests/service";
import { batchStats, createBatchFromFile, listBatchRows, startBatch } from "@/modules/merge/service";
import { guessMapping, detectPlaceholders } from "@/modules/merge/pure";
import type { TeamUser } from "@/modules/tenancy/context";
import { setupWorkspace } from "../flows";
import { clearOtps, guestSignWith } from "../flows";
import { freshBrowser } from "../helpers";

let ws = 0;
let owner: { id: number };
let team: TeamUser;

beforeAll(async () => {
  const s = await setupWorkspace("امضا و پرداخت");
  ws = s.wsId;
  owner = s.owner;
  team = { id: owner.id, workspaceId: ws, wsRole: "owner" } as unknown as TeamUser;
});

async function payViaSandbox(code: string) {
  const url = await startInstallmentPayment({ code, origin: "http://localhost:3000" });
  const u = new URL(url);
  const res = await billingCallback(new Request(`http://localhost:3000${u.pathname}${u.search}`), { params: Promise.resolve({ gateway: "sandbox" }) });
  return { res, location: res.headers.get("Location") ?? "" };
}

describe("امضا و پرداخت (Sign & Pay)", () => {
  it("بیعانه پیش‌شرط امضاست؛ پس از پرداخت درگاه، امضا آزاد می‌شود", async () => {
    const guest = await ensureGuestSigner(ws, { name: "مشتری پرداخت", mobile: "09127770001" });
    const plan = buildSchedule({ total: 9_000_000, depositPercent: 20, count: 2, intervalDays: 30, gateDeposit: true });
    if (!plan.ok) throw new Error(plan.error);
    const id = await issueContract({ workspaceId: ws, title: "قرارداد پیمانکاری", bodyHtml: "<p>متن قرارداد پیمانکاری برای آزمون.</p>", customerId: guest.userId, createdBy: owner.id, contractValue: 9_000_000, onCreated: (cid) => insertPlan(cid, ws, plan.items) });
    const rows = await listInstallments(id);
    expect(rows).toHaveLength(3);
    const [signer] = await db.select().from((await import("@/db/schema")).contractSigners).where(eq((await import("@/db/schema")).contractSigners.contractId, id));

    // ۱) بدون پرداخت: امضا سمت سرور رد می‌شود
    const blocked = await guestSignWith(signer.id);
    expect(blocked.result.ok).toBe(false);
    expect(blocked.result.error).toContain("بیعانه");

    // ۲) پرداخت بیعانه از درگاه (سندباکس) و بازگشت به صفحه‌ی پرداخت
    const dep = rows.find((r) => r.kind === "deposit")!;
    const paid = await payViaSandbox(dep.payCode);
    expect(paid.res.status).toBe(303);
    expect(paid.location).toContain(`/pay/${dep.payCode}`);
    expect(paid.location).toContain("pay=ok");
    const after = (await listInstallments(id)).find((r) => r.id === dep.id)!;
    expect(after.status).toBe("paid");
    expect(after.method).toBe("gateway");

    // ۳) بازگشت دوباره‌ی همان تراکنش اثر دوم ندارد
    const again = await billingCallback(new Request(paid.location.startsWith("http") ? paid.location : "http://localhost:3000/api/billing/callback/sandbox?Authority=x&Status=OK"), { params: Promise.resolve({ gateway: "sandbox" }) });
    expect(again.status).toBe(303);

    // ۴) اکنون امضا ممکن است (فاصله‌ی ارسال مجدد OTP در آزمون دور زده می‌شود)
    await clearOtps(signer.id);
    const signed = await guestSignWith(signer.id);
    expect(signed.result.ok, signed.result.error).toBe(true);

    // ۵) پس از امضا، تغییر برنامه ممنوع؛ ثبت دستی و داشبورد مطالبات
    await expect(setPlan({ contractId: id, workspaceId: ws, actorId: owner.id, items: [] })).rejects.toBeInstanceOf(PayError);
    const next = rows.find((r) => r.kind === "installment")!;
    await markManualPaid({ installmentId: next.id, workspaceId: ws, actorId: owner.id, note: "کارت به کارت" });
    await expect(markManualPaid({ installmentId: next.id, workspaceId: ws, actorId: owner.id, note: "" })).rejects.toBeInstanceOf(PayError);
    const rec = await receivables(ws);
    expect(rec.totals.paid).toBeGreaterThanOrEqual(dep.amount + next.amount);
  });

  it("قسط سررسیدگذشته یادآوری می‌شود (یک‌بار در هر بازه) و پرداخت لغو/نامعتبر مجاز نیست", async () => {
    const guest = await ensureGuestSigner(ws, { name: "مشتری اقساط", mobile: "09127770002" });
    const id = await issueContract({ workspaceId: ws, title: "قرارداد اقساطی", bodyHtml: "<p>متن قرارداد اقساطی برای آزمون.</p>", customerId: guest.userId, createdBy: owner.id });
    const [signer] = await db.select().from((await import("@/db/schema")).contractSigners).where(eq((await import("@/db/schema")).contractSigners.contractId, id));
    await insertPlan(id, ws, [{ title: "قسط ۱", kind: "installment", amount: 50_000, dueAt: "2020-01-01", gate: "none", payerPosition: 0 }]);
    const signed = await guestSignWith(signer.id);
    expect(signed.result.ok).toBe(true);
    expect(await runInstallmentReminders(ws)).toBeGreaterThanOrEqual(1);
    expect(await runInstallmentReminders(ws)).toBe(0);
    const [inst] = await listInstallments(id);
    expect(inst.reminderCount).toBe(1);
    await expect(startInstallmentPayment({ code: "bad", origin: "http://localhost:3000" })).rejects.toBeInstanceOf(PayError);
    await db.update(contractInstallments).set({ status: "cancelled" }).where(eq(contractInstallments.id, inst.id));
    await expect(startInstallmentPayment({ code: inst.payCode, origin: "http://localhost:3000" })).rejects.toBeInstanceOf(PayError);
  });
});

describe("ارسال انبوه از اکسل (Mail-Merge)", () => {
  it("برای هر ردیف قرارداد شخصی می‌سازد؛ ردیف نامعتبر/تکراری رد می‌شود؛ برنامه‌ی پرداخت همراه است", async () => {
    freshBrowser();
    const [tpl] = await db
      .insert(templates)
      .values({ workspaceId: ws, title: "قرارداد استخدام {{سمت}}", body: "<p>آقا/خانم [USER_NAME] به سمت {{سمت}} با حقوق [SALARY] تومان استخدام می‌شود.</p>" })
      .returning();
    const csv = ["نام و نام خانوادگی,موبایل,سمت,SALARY,مبلغ", "علی رضایی,09121110011,برنامه‌نویس,۱۰٬۰۰۰٬۰۰۰,12000000", "مریم احمدی,۰۹۱۲۱۱۱۰۰۲۲,<script>x</script>,۸۰۰۰۰۰۰,6000000", "خراب,123,مدیر,5,5000000", "علی رضایی,09121110011,برنامه‌نویس,۱۰٬۰۰۰٬۰۰۰,12000000", "بدون مبلغ,09121110033,مدیر,5,"].join("\n");
    const id = await createBatchFromFile(team, { templateId: tpl.id, title: "آزمون", fileName: "staff.csv", bytes: new TextEncoder().encode(csv) });
    const { getBatch, batchHeaders } = await import("@/modules/merge/service");
    const batch = (await getBatch(id, ws))!;
    const mapping = guessMapping(batchHeaders(batch), detectPlaceholders(batch.bodyHtml, batch.contractTitle));
    expect(mapping.roles.name).toBe("نام و نام خانوادگی");
    expect(mapping.vars["سمت"]).toBe("سمت");

    const r = await startBatch(team, id, { mapping, options: { contractTitle: "قرارداد استخدام {{سمت}}", signerLabel: "کارمند", expiryDays: 7, plan: { enabled: true, depositPercent: 25, count: 2, intervalDays: 30, gateDeposit: true } } });
    expect(r.queued).toBe(2);
    expect(r.invalid).toBe(2); // موبایل نامعتبر + مبلغ خالی
    expect(r.skipped).toBe(1); // تکراری

    // صف در حالت آزمون همگام اجرا می‌شود
    const st = await batchStats(id);
    expect(st.sent).toBe(2);
    const rows = await listBatchRows(id);
    const sent = rows.filter((x) => x.row.status === "sent");
    expect(sent).toHaveLength(2);
    const [c1] = await db.select().from(contracts).where(eq(contracts.id, sent[0].row.contractId!));
    expect(c1.bodyHtml).toContain("علی رضایی");
    expect(c1.bodyHtml).toContain("برنامه‌نویس");
    expect(c1.bodyHtml).toContain("جدول تعهدات مالی");
    expect(c1.title).toBe("قرارداد استخدام برنامه‌نویس");
    expect(c1.contractValue).toBe(12_000_000);
    const [c2] = await db.select().from(contracts).where(eq(contracts.id, sent[1].row.contractId!));
    expect(c2.bodyHtml).not.toContain("<script>");
    const plan = await listInstallments(c1.id);
    expect(plan.reduce((s, p) => s + p.amount, 0)).toBe(12_000_000);
    expect(plan[0].gate).toBe("before_sign");

    // شروع دوباره‌ی همان دسته مجاز نیست
    await expect(startBatch(team, id, { mapping, options: {} })).rejects.toThrow();
    // ایزولاسیون: دسته‌ی فضای دیگر دیده نمی‌شود
    expect(await getBatch(id, ws + 9999)).toBeNull();
    // ردیف‌های پایگاه‌داده‌ای ذخیره شده‌اند
    expect((await db.select().from(mergeRows).where(eq(mergeRows.batchId, id))).length).toBe(5);
  });
});

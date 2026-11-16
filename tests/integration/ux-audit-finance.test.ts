/**
 * ممیزی UX بخش مالی (پرداخت‌ها، اشتراک، کیف پول، فاکتور، بیعانه/قسط).
 * فایل جدید است؛ هیچ آزمون موجودی تغییر نکرده است.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { invoices, payments, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { flashQuery, loginNextFor, readFlash } from "@/lib/flash";
import { safeNext } from "@/modules/auth/validation";
import { createSession } from "@/modules/auth/session";
import { createWorkspace } from "@/modules/tenancy/service";
import { startCheckout, verifyPayment } from "@/modules/billing/service";
import { paymentPhase, friendlyPaymentError } from "@/modules/billing/payment-status";
import { paymentReceipt, recentOpenTopups } from "@/modules/billing/receipt";
import { issueInvoiceForPayment } from "@/modules/billing/invoices";
import { reconcilePendingPayments, recheckPayment, startPayment } from "@/modules/payments/service";
import { paymentReturn } from "@/modules/payments/return";
import { payPlanWithWallet } from "@/modules/wallet/purchase";
import { creditToman } from "@/modules/wallet/service";
import { GET as billingCallback } from "@/app/api/billing/callback/[gateway]/route";
import { GET as invoicePdf } from "@/app/api/billing/invoices/[id]/pdf/route";
import { GET as invoiceCsv } from "@/app/api/billing/invoices/export/route";
import { INVOICE_ERRORS } from "@/modules/billing/invoice-http";
import { GATEWAY_SESSION_MS, VERIFY_PENDING } from "@/modules/payments/types";
import { renderToStaticMarkup } from "react-dom/server";
import PayReceiptPage from "@/app/pay/[code]/receipt/page";
import { ensureGuestSigner } from "@/modules/guests/service";
import { issueContract } from "@/modules/contracts/service";
import { buildSchedule } from "@/modules/contract-pay/schedule";
import { insertPlan, listInstallments, startInstallmentPayment } from "@/modules/contract-pay/service";
import { setupWorkspace } from "../flows";
import { SimClient, startSimulator, type SimHandle } from "../../simulator";
import { freshBrowser, uniq } from "../helpers";

const origin = "http://localhost:3000";
const MIN = 60_000;
let seq = 0;
async function makeUser(label = "مالی-ux") {
  const [u] = await db.insert(users).values({ name: label, email: `${uniq("fux")}@example.com`, mobile: `0915${String(4000000 + ++seq * 17)}`, passwordHash: hashPassword("Fin12345xy"), emailVerifiedAt: new Date() }).returning();
  const ws = await createWorkspace(u.id, `${label} ${seq}`);
  return { ...u, ws };
}
const authorityOf = (url: string) => new URL(url).searchParams.get("Authority") ?? url.split("/").pop()!;
const callbackUrl = (url: string) => { const u = new URL(url); return `${origin}${u.pathname}${u.search}`; };
const params = (gateway: string) => ({ params: Promise.resolve({ gateway }) });
const locationOf = (res: Response) => res.headers.get("Location") ?? "";
const flashOf = (loc: string) => { const q = new URL(loc, origin).searchParams; return readFlash({ pay: q.get("pay") ?? undefined, msg: q.get("msg") ?? undefined, pid: q.get("pid") ?? undefined, sig: q.get("sig") ?? undefined }); };

/* ───────── ۱) پیام نتیجه‌ی پرداخت: ضد جعل ───────── */
describe("پیام نتیجه‌ی پرداخت امضا می‌شود (جعل پیام از روی آدرس ممکن نیست)", () => {
  it("پیام امضاشده خوانده می‌شود، هر دستکاری (متن، نوع، شناسه، امضا) رد می‌شود", () => {
    const q = new URLSearchParams(flashQuery("ok", "پرداخت با موفقیت انجام شد", 42));
    const sp = { pay: q.get("pay")!, msg: q.get("msg")!, pid: q.get("pid")!, sig: q.get("sig")! };
    expect(readFlash(sp)).toEqual({ pay: "ok", msg: "پرداخت با موفقیت انجام شد", pid: 42 });
    expect(readFlash({ ...sp, msg: "پرداخت شما تایید شد؛ ۱۰ میلیون اعتبار هدیه!" })).toBeNull();
    expect(readFlash({ ...sp, pay: "error" })).toBeNull();
    expect(readFlash({ ...sp, pid: "43" })).toBeNull();
    expect(readFlash({ ...sp, pid: undefined })).toBeNull();
    expect(readFlash({ ...sp, sig: "0".repeat(32) })).toBeNull();
    expect(readFlash({ ...sp, sig: undefined })).toBeNull();
  });

  it("لینک بدون امضا (قالب قدیمی/فیشینگ) هیچ متنی نشان نمی‌دهد", () => {
    expect(readFlash({ pay: "ok", msg: "اشتراک شما فعال شد" })).toBeNull();
    expect(readFlash({ pay: "<script>", msg: "x", sig: "y" })).toBeNull();
    expect(readFlash(undefined)).toBeNull();
    expect(readFlash({ pay: "ok", msg: "x".repeat(500), sig: "a" })).toBeNull();
  });

  it("مسیر ورود با بازگشت (نشست تمام‌شده هنگام بازگشت از درگاه) از safeNext می‌گذرد و نتیجه را حفظ می‌کند", () => {
    const sp = Object.fromEntries(new URLSearchParams(flashQuery("ok", "کیف پول با موفقیت شارژ شد", 7)));
    const login = loginNextFor("/admin/wallet", sp);
    const next = new URL(login, origin).searchParams.get("next")!;
    expect(safeNext(next)).toBe(next);
    const q = new URL(next, origin).searchParams;
    expect(readFlash({ pay: q.get("pay")!, msg: q.get("msg")!, pid: q.get("pid")!, sig: q.get("sig")! })?.pid).toBe(7);
    // بدون پیام معتبر فقط مسیر
    expect(loginNextFor("/admin/billing", { pay: "ok", msg: "جعلی" })).toBe(`/login?next=${encodeURIComponent("/admin/billing")}`);
  });
});

/* ───────── ۲) وضعیت قابل‌فهم پرداخت ───────── */
describe("وضعیت پرداخت برای کاربر (به‌جای «در انتظار» ابدی)", () => {
  const now = Date.now();
  const base = { status: "pending", error: null, createdAt: new Date(now - 2 * MIN), gateway: "zarinpal", authority: "A00000000000000000000000000000000001", amount: 100_000 };

  it("pending تازه ← در انتظار (با امکان بررسی وضعیت)", () => {
    const p = paymentPhase(base, now);
    expect(p.phase).toBe("waiting");
    expect(p.canRecheck).toBe(true);
    expect(p.canRetry).toBe(false);
  });
  it("pending قدیمی‌تر از پنجره‌ی نشست درگاه ← ناتمام (با پرداخت دوباره)", () => {
    const p = paymentPhase({ ...base, createdAt: new Date(now - GATEWAY_SESSION_MS - MIN) }, now);
    expect(p.phase).toBe("abandoned");
    expect(p.canRetry).toBe(true);
    expect(p.canRecheck).toBe(true);
  });
  it("verify_pending ← در حال بررسی؛ هرگز «ناموفق» یا دعوت به پرداخت دوباره (پول ممکن است کسر شده باشد)", () => {
    const p = paymentPhase({ ...base, error: `${VERIFY_PENDING}: timeout` }, now);
    expect(p.phase).toBe("processing");
    expect(p.canRetry).toBe(false);
    expect(p.hint).toContain("کسر");
  });
  it("sandbox و کیف پول هرگز قابل «بررسی وضعیت» نیستند (verify آزمایشی همیشه paid است)", () => {
    expect(paymentPhase({ ...base, gateway: "sandbox" }, now).canRecheck).toBe(false);
    expect(paymentPhase({ ...base, gateway: "wallet" }, now).canRecheck).toBe(false);
  });
  it("ناموفق: دلیل فارسی نشان داده می‌شود، شناسه‌ی فنی خام نه", () => {
    expect(paymentPhase({ ...base, status: "failed", error: "مبلغ پرداخت‌شده با مبلغ سفارش مطابقت ندارد" }, now).hint).toContain("مطابقت");
    expect(friendlyPaymentError("activation_failed")).toContain("برگشت");
    expect(friendlyPaymentError("ERR_502_BAD_GATEWAY")).toBe("پرداخت از سمت درگاه تایید نشد.");
    expect(friendlyPaymentError(null)).toBe("پرداخت کامل نشد.");
  });
  it("پرداخت کاملاً مسترد‌شده ← مسترد شد", () => {
    expect(paymentPhase({ ...base, status: "paid", refundedAmount: 100_000 }, now).phase).toBe("refunded");
    expect(paymentPhase({ ...base, status: "paid", refundedAmount: 10_000 }, now).phase).toBe("paid");
  });
});

/* ───────── ۳) بازگشت از درگاه: رسید از دیتابیس + پیام امضاشده ───────── */
describe("بازگشت از درگاه ← مقصد درست، پیام امضاشده، رسید با کد پیگیری و فاکتور", () => {
  it("اشتراک: Location امضاشده و pid دارد؛ رسید از دیتابیس کد پیگیری و فاکتور می‌دهد", async () => {
    const u = await makeUser();
    const url = await startCheckout({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1, origin });
    const res = await billingCallback(new Request(callbackUrl(url)), params("sandbox"));
    expect(res.status).toBe(303);
    const loc = locationOf(res);
    expect(loc.startsWith("/admin/billing?")).toBe(true);
    const f = flashOf(loc);
    expect(f?.pay).toBe("ok");
    expect(f?.pid).toBeGreaterThan(0);
    const r = await paymentReceipt(u.ws, f!.pid!);
    expect(r?.kind).toBe("subscription");
    expect(r?.refId).toMatch(/^DEMO-/);
    expect(r?.phase.phase).toBe("paid");
    expect(r?.invoice?.number).toMatch(/^INV-\d+-\d{6}$/);
    expect(r?.title).toContain("اشتراک");
  });

  it("پیام جعلی به‌جای امضای واقعی هیچ‌وقت پذیرفته نمی‌شود و رسید فضای کاری دیگر نشت نمی‌کند", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const url = await startCheckout({ workspaceId: a.ws, userId: a.id, plan: "pro", months: 1, origin });
    const f = flashOf(locationOf(await billingCallback(new Request(callbackUrl(url)), params("sandbox"))))!;
    expect(await paymentReceipt(b.ws, f.pid!)).toBeNull();
    expect(await paymentReceipt(a.ws, 0)).toBeNull();
    expect(await paymentReceipt(a.ws, 9_999_999)).toBeNull();
  });

  it("شارژ کیف پول به /admin/wallet برمی‌گردد و رسید «شارژ کیف پول» (بدون فاکتور) دارد", async () => {
    const u = await makeUser();
    const url = await startPayment({ kind: "topup", workspaceId: u.ws, userId: u.id, amountToman: 120_000, origin, description: "شارژ" });
    const loc = locationOf(await billingCallback(new Request(callbackUrl(url)), params("sandbox")));
    expect(loc.startsWith("/admin/wallet?")).toBe(true);
    const f = flashOf(loc)!;
    const r = await paymentReceipt(u.ws, f.pid!);
    expect(r?.kind).toBe("topup");
    expect(r?.title).toBe("شارژ کیف پول");
    expect(r?.invoice).toBeNull();
  });

  it("لغو در درگاه: پیام خطای امضاشده و رسید «ناموفق» با راه پرداخت دوباره", async () => {
    const u = await makeUser();
    const url = await startCheckout({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1, origin });
    const cancelled = callbackUrl(url).replace("Status=OK", "Status=NOK");
    const loc = locationOf(await billingCallback(new Request(cancelled), params("sandbox")));
    const f = flashOf(loc)!;
    expect(f.pay).toBe("error");
    const r = await paymentReceipt(u.ws, f.pid!);
    expect(r?.phase.phase).toBe("failed");
    expect(r?.phase.canRetry).toBe(true);
    expect(r?.phase.hint).toContain("لغو");
  });

  it("بازگشت بدون توکن/درگاه ناشناخته: پیام امضاشده (نه خطای خام)", async () => {
    const loc = locationOf(await billingCallback(new Request(`${origin}/api/billing/callback/sandbox`), params("sandbox")));
    expect(flashOf(loc)?.pay).toBe("error");
    const bad = locationOf(await billingCallback(new Request(`${origin}/api/billing/callback/nope`), params("nope")));
    expect(flashOf(bad)?.msg).toBe("درگاه نامعتبر است");
    const r = await paymentReturn({ ok: false, message: "x" }, "");
    expect(r.dest).toBe("/admin/billing");
  });
});

/* ───────── ۴) کیف پول: کمبود موجودی ───────── */
describe("خرید اشتراک با کیف پول: کمبود موجودی روشن و قابل‌اقدام است", () => {
  it("خطا مقدار دقیق کمبود را می‌دهد (برای شارژ یک‌کلیکی)", async () => {
    const u = await makeUser();
    await creditToman(u.ws, 100_000, { kind: "topup", ref: uniq("tp"), description: "آزمون" });
    const r = await payPlanWithWallet({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.shortfall).toBeGreaterThan(0);
      expect(r.error).toContain("کم دارید");
      expect(r.error).toContain("شارژ");
    }
    // ردیف پرداخت نیمه‌کاره‌ای باقی نمی‌ماند
    const left = await db.select().from(payments).where(and(eq(payments.workspaceId, u.ws), eq(payments.gateway, "wallet")));
    expect(left).toHaveLength(0);
  });

  it("خرید موفق شناسه‌ی پرداخت را برای رسید برمی‌گرداند و فاکتور دارد", async () => {
    const u = await makeUser();
    await creditToman(u.ws, 5_000_000, { kind: "topup", ref: uniq("tp"), description: "آزمون" });
    const r = await payPlanWithWallet({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const rec = await paymentReceipt(u.ws, r.paymentId!);
      expect(rec?.refId).toMatch(/^W-/);
      expect(rec?.invoice).not.toBeNull();
    }
  });
});

/* ───────── ۵) پرداخت بدون بازگشت (تب بسته شد) ───────── */
describe("کاربر پرداخت کرد ولی به سایت برنگشت: بازبینی خودکار و دستی", () => {
  let sim: SimHandle;
  let c: SimClient;
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    sim = await startSimulator({ port: 0, quiet: true, startPay: "auto" });
    c = new SimClient(sim.url);
    for (const k of ["EXTERNAL_SIM_URL", "EXTERNAL_TIMEOUT_SCALE", "ZARINPAL_MERCHANT_ID"]) saved[k] = process.env[k];
    process.env.EXTERNAL_SIM_URL = sim.url;
    process.env.EXTERNAL_TIMEOUT_SCALE = "0.02";
    delete process.env.ZARINPAL_MERCHANT_ID;
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await sim.close();
  });
  beforeEach(async () => {
    await c.reset();
    await c.settings({ startPay: "auto" });
  });
  const age = (authority: string, ms: number) => db.update(payments).set({ createdAt: new Date(Date.now() - ms) }).where(eq(payments.authority, authority));
  const rowOf = async (authority: string) => (await db.select().from(payments).where(eq(payments.authority, authority)))[0];

  it("callback_dropped: پس از ۱۰ دقیقه، زمان‌بند پرداخت واقعی را از درگاه می‌گیرد و اشتراک فعال می‌شود (پیش‌تر برای همیشه pending می‌ماند)", async () => {
    const u = await makeUser();
    await c.scenario("zarinpal", "callback_dropped");
    const url = await startCheckout({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1, origin });
    await fetch(url, { redirect: "manual" }); // کاربر پرداخت کرد…
    const authority = authorityOf(url);
    expect((await c.payment(authority)).status).toBe("paid"); // …ولی بازگشت قطع شد
    await reconcilePendingPayments();
    expect((await rowOf(authority)).status).toBe("pending"); // تازه است: هنوز ممکن است کاربر در صفحه‌ی درگاه باشد
    await age(authority, 15 * MIN);
    const rec = await reconcilePendingPayments();
    expect(rec.paid).toBeGreaterThanOrEqual(1);
    const row = await rowOf(authority);
    expect(row.status).toBe("paid");
    expect(row.fulfilledAt).not.toBeNull();
    expect((await paymentReceipt(u.ws, row.id))?.invoice).not.toBeNull();
  });

  it("پرداخت‌نشده: بازبینی نرم تراکنش را ناموفق نمی‌کند (کاربر ممکن است هنوز در درگاه باشد) و پس از ۲ ساعت بسته می‌شود", async () => {
    const u = await makeUser();
    const url = await startCheckout({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1, origin });
    const authority = authorityOf(url); // هرگز در درگاه پرداخت نمی‌شود
    await age(authority, 15 * MIN);
    await reconcilePendingPayments();
    expect((await rowOf(authority)).status).toBe("pending");
    const manual = await recheckPayment(u.ws, (await rowOf(authority)).id);
    expect(manual.ok).toBe(false);
    expect(manual.message).toContain("هنوز پرداختی");
    expect((await rowOf(authority)).status).toBe("pending");
    await age(authority, GATEWAY_SESSION_MS + 5 * MIN);
    await reconcilePendingPayments();
    expect((await rowOf(authority)).status).toBe("failed");
  });

  it("«بررسی وضعیت» دستی: پرداخت‌شده در درگاه ← اعمال و رسید؛ فقط همان فضای کاری", async () => {
    const u = await makeUser();
    const other = await makeUser();
    await c.scenario("zarinpal", "callback_dropped");
    const url = await startCheckout({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1, origin });
    await fetch(url, { redirect: "manual" });
    const row = await rowOf(authorityOf(url));
    expect((await recheckPayment(other.ws, row.id)).ok).toBe(false); // فضای دیگر نمی‌تواند
    expect((await rowOf(authorityOf(url))).status).toBe("pending");
    const r = await recheckPayment(u.ws, row.id);
    expect(r.ok).toBe(true);
    expect((await rowOf(authorityOf(url))).status).toBe("paid");
    // اجرای دوباره بی‌اثر و ایدمپوتنت
    expect((await recheckPayment(u.ws, row.id)).ok).toBe(true);
    expect((await db.select().from(invoices).where(and(eq(invoices.paymentId, row.id), eq(invoices.kind, "invoice")))).length).toBe(1);
  });

  it("شارژ ناتمام در فهرست «شارژهای تکمیل‌نشده» می‌آید تا کاربر بتواند بررسی کند", async () => {
    const u = await makeUser();
    await startPayment({ kind: "topup", workspaceId: u.ws, userId: u.id, amountToman: 50_000, origin, description: "شارژ" });
    const open = await recentOpenTopups(u.ws);
    expect(open).toHaveLength(1);
    expect(open[0].phase.canRecheck).toBe(true);
  });
});

/* ───────── ۶) درگاه آزمایشی هرگز خودکار «پرداخت‌شده» نمی‌شود ───────── */
describe("ایمنی: پرداخت آزمایشی رهاشده با زمان‌بند یا بررسی دستی رایگان فعال نمی‌شود", () => {
  it("sandbox رهاشده: reconcile آن را paid نمی‌کند؛ بررسی دستی رد می‌شود؛ پس از ۲ ساعت ناموفق می‌شود", async () => {
    const u = await makeUser();
    const url = await startCheckout({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1, origin });
    const authority = authorityOf(url);
    const [row] = await db.select().from(payments).where(eq(payments.authority, authority));
    await db.update(payments).set({ createdAt: new Date(Date.now() - 30 * MIN) }).where(eq(payments.id, row.id));
    await reconcilePendingPayments();
    expect((await db.select().from(payments).where(eq(payments.id, row.id)))[0].status).toBe("pending");
    const r = await recheckPayment(u.ws, row.id);
    expect(r.ok).toBe(false);
    expect((await db.select().from(payments).where(eq(payments.id, row.id)))[0].status).toBe("pending");
    await db.update(payments).set({ createdAt: new Date(Date.now() - GATEWAY_SESSION_MS - 5 * MIN) }).where(eq(payments.id, row.id));
    await reconcilePendingPayments();
    expect((await db.select().from(payments).where(eq(payments.id, row.id)))[0].status).toBe("failed");
    // و بازگشت دیرهنگام آن هم دیگر فعال‌سازی نمی‌کند
    expect((await verifyPayment(authority, "OK")).ok).toBe(false);
  });
});

/* ───────── ۷) دانلود فاکتور بدون بن‌بست ───────── */
describe("دانلود فاکتور: خطا برای مرورگر به صفحه‌ی فاکتورها برمی‌گردد، برای API همان کد وضعیت", () => {
  const nav = { "sec-fetch-mode": "navigate", accept: "text/html" };
  const call = (id: number | string, headers: Record<string, string> = {}) => invoicePdf(new Request(`${origin}/api/billing/invoices/${id}/pdf`, { headers }), { params: Promise.resolve({ id: String(id) }) });

  beforeEach(() => {
    freshBrowser();
  });

  it("بدون نشست: مرورگر ← صفحه‌ی ورود با بازگشت؛ API ← 401", async () => {
    const page = await call(1, nav);
    expect(page.status).toBe(303);
    expect(page.headers.get("Location")).toContain("/login?next=");
    const api = await call(1);
    expect(api.status).toBe(401);
  });

  it("فاکتور ناموجود/متعلق به دیگری: مرورگر ← ?e=nodoc با پیام فارسی؛ API ← 404", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    await creditToman(owner.ws, 5_000_000, { kind: "topup", ref: uniq("tp"), description: "آزمون" });
    const r = await payPlanWithWallet({ workspaceId: owner.ws, userId: owner.id, plan: "pro", months: 1 });
    expect(r.ok).toBe(true);
    const [inv] = await db.select().from(invoices).where(eq(invoices.workspaceId, owner.ws));

    freshBrowser();
    await createSession(stranger.id, stranger.passwordHash);
    const page = await call(inv.id, nav);
    expect(page.status).toBe(303);
    expect(page.headers.get("Location")).toContain("/admin/billing/invoices?e=nodoc");
    expect(INVOICE_ERRORS.nodoc).toContain("پیدا نشد");
    expect((await call(inv.id)).status).toBe(404);
    expect((await call("abc", nav)).headers.get("Location")).toContain("e=nodoc");

    // صاحب فاکتور PDF واقعی می‌گیرد
    freshBrowser();
    await createSession(owner.id, owner.passwordHash);
    const ok = await call(inv.id, nav);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("application/pdf");
    expect(ok.headers.get("Content-Disposition")).toContain(`${inv.number}.pdf`);
    const bytes = new Uint8Array(await ok.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("%PDF");
  });

  it("سقف نرخ دانلود: مرورگر ← ?e=rate، API ← 429", async () => {
    const u = await makeUser();
    freshBrowser();
    await createSession(u.id, u.passwordHash);
    for (let i = 0; i < 30; i++) await call(999_999, {});
    expect((await call(999_999, nav)).headers.get("Location")).toContain("e=rate");
    expect((await call(999_999)).status).toBe(429);
  });

  it("خروجی CSV فاکتورها: BOM، ستون‌ها و فقط فاکتورهای همان فضای کاری؛ بدون نشست ← 401", async () => {
    const a = await makeUser();
    const b = await makeUser();
    for (const u of [a, b]) {
      await creditToman(u.ws, 5_000_000, { kind: "topup", ref: uniq("tp"), description: "آزمون" });
      await payPlanWithWallet({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1 });
    }
    freshBrowser();
    expect((await invoiceCsv(new Request(`${origin}/api/billing/invoices/export`))).status).toBe(401);
    await createSession(a.id, a.passwordHash);
    const res = await invoiceCsv(new Request(`${origin}/api/billing/invoices/export`));
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect([...buf.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM برای Excel
    const text = new TextDecoder().decode(buf);
    const lines = text.trim().split(/\r\n/);
    expect(lines).toHaveLength(2); // سرستون + یک فاکتور
    const mine = (await db.select().from(invoices).where(eq(invoices.workspaceId, a.ws)))[0];
    expect(lines[1]).toContain(mine.number);
  });
});

/* ───────── ۸) بیعانه/قسط: رسید قابل‌چاپ ───────── */
describe("رسید پرداخت بیعانه (/pay/[code]/receipt)", () => {
  it("قسط پرداخت‌نشده رسید ندارد؛ پس از پرداخت درگاهی رسید با مبلغ و کد پیگیری ساخته می‌شود؛ کد نامعتبر پیام روشن می‌دهد", async () => {
    const s = await setupWorkspace("رسید بیعانه");
    const guest = await ensureGuestSigner(s.wsId, { name: "مشتری رسید", mobile: "09127770042" });
    const plan = buildSchedule({ total: 6_000_000, depositPercent: 25, count: 1, intervalDays: 30, gateDeposit: false });
    if (!plan.ok) throw new Error(plan.error);
    const id = await issueContract({ workspaceId: s.wsId, title: "قرارداد رسید", bodyHtml: "<p>متن قرارداد برای آزمون رسید پرداخت.</p>", customerId: guest.userId, createdBy: s.owner.id, contractValue: 6_000_000, onCreated: (cid) => insertPlan(cid, s.wsId, plan.items) });
    const dep = (await listInstallments(id)).find((r) => r.kind === "deposit")!;

    const html = async (code: string) => renderToStaticMarkup(await PayReceiptPage({ params: Promise.resolve({ code }) }));
    expect(await html(dep.payCode)).toContain("هنوز پرداخت نشده");
    expect(await html("x".repeat(30))).toContain("لینک رسید نامعتبر");

    const url = await startInstallmentPayment({ code: dep.payCode, origin });
    const loc = locationOf(await billingCallback(new Request(callbackUrl(url)), params("sandbox")));
    expect(loc).toContain(`/pay/${dep.payCode}`);
    expect(flashOf(loc)?.pay).toBe("ok"); // پیام صفحه‌ی پرداخت هم امضاشده است

    const page = await html(dep.payCode);
    expect(page).toContain("رسید پرداخت");
    expect(page).toContain("قرارداد رسید");
    expect(page).toContain("۱٬۵۰۰٬۰۰۰"); // ۲۵٪ از ۶ میلیون
    expect(page).toMatch(/DEMO-\d+/);
    expect(page).toContain("درگاه پرداخت آنلاین");
  });
});

/* ───────── ۹) فاکتور ایدمپوتنت (بدون تغییر رفتار) ───────── */
describe("صدور فاکتور همچنان ایدمپوتنت است", () => {
  it("دو بار صدور همان فاکتور را برمی‌گرداند", async () => {
    const u = await makeUser();
    await creditToman(u.ws, 5_000_000, { kind: "topup", ref: uniq("tp"), description: "آزمون" });
    const r = await payPlanWithWallet({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1 });
    if (!r.ok) throw new Error(r.error);
    const a = await db.transaction((tx) => issueInvoiceForPayment(tx, r.paymentId!));
    const b = await db.transaction((tx) => issueInvoiceForPayment(tx, r.paymentId!));
    expect(a?.id).toBe(b?.id);
  });
});

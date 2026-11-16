import { normalizeDigits } from "@/lib/numbers";
import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { invoiceCounters, invoices, payments, users, workspaces } from "@/db/schema";
import { escapeHtml } from "@/lib/html";
import { fa } from "@/lib/jalali";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";
import { getPlanById } from "./catalog";

/**
 * فاکتور رسمی اشتراک پلتفرم.
 *
 * صدور همیشه «ایدمپوتنت و بدون جا افتادگی» است: قفل مشاوره‌ایِ هر پرداخت، سپس شمارنده‌ی پیوسته (آخرین قفل تا پایان تراکنش نگه داشته می‌شود).
 * مالیات (ارزش افزوده) «شامل‌شده در قیمت» است؛ نرخ از تنظیمات پلتفرم (پیش‌فرض ۱۰٪؛ صفر = بدون مالیات).
 */

export type InvoiceExecutor = Pick<typeof db, "select" | "insert" | "update" | "execute">;
export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceItem = { title: string; qty: number; amount: number };
export type Party = { name: string; email?: string; economicCode?: string; nationalId?: string; address?: string; phone?: string; workspace?: string };

const INVOICE_LOCK_NS = 727_003;

/* ───────────── تنظیمات فروشنده/مالیات (سطح پلتفرم) ───────────── */
export const INVOICE_SETTING_KEYS = ["invoice.tax_percent", "invoice.seller_name", "invoice.seller_economic_code", "invoice.seller_national_id", "invoice.seller_address", "invoice.seller_phone", "invoice.footer_note"] as const;
export type InvoiceSettings = { taxPercent: number; sellerName: string; economicCode: string; nationalId: string; address: string; phone: string; footerNote: string };

export function clampTaxPercent(v: unknown): number {
  const n = Math.round(Number(normalizeDigits(v)));
  return Number.isFinite(n) ? Math.min(40, Math.max(0, n)) : 10;
}

export async function getInvoiceSettings(): Promise<InvoiceSettings> {
  const [tax, name, eco, nid, addr, phone, note] = await Promise.all(INVOICE_SETTING_KEYS.map((k) => getGlobalSetting(k)));
  return { taxPercent: tax === "" ? 10 : clampTaxPercent(tax), sellerName: name || "امضاگیر", economicCode: eco, nationalId: nid, address: addr, phone, footerNote: note };
}

export async function saveInvoiceSettings(v: Partial<InvoiceSettings>): Promise<void> {
  const map: [string, string | undefined][] = [
    ["invoice.tax_percent", v.taxPercent === undefined ? undefined : String(clampTaxPercent(v.taxPercent))],
    ["invoice.seller_name", v.sellerName?.trim().slice(0, 120)],
    ["invoice.seller_economic_code", v.economicCode?.trim().slice(0, 30)],
    ["invoice.seller_national_id", v.nationalId?.trim().slice(0, 30)],
    ["invoice.seller_address", v.address?.trim().slice(0, 300)],
    ["invoice.seller_phone", v.phone?.trim().slice(0, 30)],
    ["invoice.footer_note", v.footerNote?.trim().slice(0, 300)],
  ];
  for (const [k, val] of map) if (val !== undefined) await saveGlobalSetting(k, val);
}

/* ───────────── محاسبات ───────────── */

/** مالیات «شامل‌شده»: از مبلغ نهایی (با مالیات) سهم مالیات را جدا می‌کند */
export function splitInclusiveTax(total: number, percent: number): { subtotal: number; tax: number } {
  if (percent <= 0 || total === 0) return { subtotal: total, tax: 0 };
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const tax = Math.round((abs * percent) / (100 + percent));
  return { subtotal: sign * (abs - tax), tax: sign * tax };
}

export function jalaliYearOf(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-u-ca-persian", { year: "numeric", timeZone: "Asia/Tehran" }).formatToParts(d);
  return parts.find((p) => p.type === "year")?.value.replace(/\D/g, "") ?? String(d.getFullYear() - 621);
}

async function nextSeq(tx: InvoiceExecutor, prefix: "INV" | "CN", at: Date): Promise<{ seq: number; number: string }> {
  const year = jalaliYearOf(at);
  const [r] = await tx
    .insert(invoiceCounters)
    .values({ key: `${prefix}-${year}`, last: 1 })
    .onConflictDoUpdate({ target: invoiceCounters.key, set: { last: sql`${invoiceCounters.last} + 1` } })
    .returning({ last: invoiceCounters.last });
  return { seq: r.last, number: `${prefix}-${year}-${String(r.last).padStart(6, "0")}` };
}

const trackingCode = () => `EMZ${crypto.randomInt(0, 10_000_000_000).toString().padStart(10, "0")}`;

async function partiesFor(tx: InvoiceExecutor, workspaceId: number, userId: number | null): Promise<{ buyer: Party; seller: Party }> {
  const [ws] = await tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const [u] = userId ? await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId)) : [];
  const s = await getInvoiceSettings();
  return {
    buyer: { name: u?.name || ws?.name || "—", email: u?.email, workspace: ws?.name },
    seller: { name: s.sellerName, economicCode: s.economicCode, nationalId: s.nationalId, address: s.address, phone: s.phone },
  };
}

/* ───────────── صدور ───────────── */

/**
 * صدور فاکتور برای پرداخت موفق اشتراک. اگر پیش‌تر صادر شده همان را برمی‌گرداند (ایدمپوتنت).
 * فقط پرداخت‌های `paid` از نوع اشتراک فاکتور می‌گیرند (شارژ کیف پول پیش‌دریافت است و خدمت ندارد؛ فاکتور هنگام خرید طرح از کیف پول صادر می‌شود).
 */
export async function issueInvoiceForPayment(tx: InvoiceExecutor, paymentId: number): Promise<InvoiceRow | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(${INVOICE_LOCK_NS}::int, ${paymentId}::int)`);
  const [existing] = await tx.select().from(invoices).where(and(eq(invoices.paymentId, paymentId), eq(invoices.kind, "invoice")));
  if (existing) return existing;
  const [pay] = await tx.select().from(payments).where(eq(payments.id, paymentId));
  if (!pay || pay.status !== "paid" || pay.kind !== "subscription" || pay.amount <= 0) return null;

  const plan = await getPlanById(pay.plan).catch(() => null);
  const listPrice = pay.listPrice ?? pay.amount;
  const discount = Math.max(0, listPrice - pay.amount);
  const items: InvoiceItem[] = [{ title: `اشتراک پلن «${plan?.name ?? pay.plan}» — ${pay.months} ماه`, qty: 1, amount: listPrice }];
  if (discount > 0) items.push({ title: "اعتبار روزهای باقی‌مانده‌ی پلن قبلی (محاسبه‌ی Proration)", qty: 1, amount: -discount });
  if (pay.bonusDays > 0) items.push({ title: `${pay.bonusDays} روز تمدید هدیه (مازاد اعتبار پلن قبلی)`, qty: 1, amount: 0 });

  const settings = await getInvoiceSettings();
  const { subtotal, tax } = splitInclusiveTax(pay.amount, settings.taxPercent);
  const at = pay.paidAt ?? new Date();
  const { seq, number } = await nextSeq(tx, "INV", at);
  const { buyer, seller } = await partiesFor(tx, pay.workspaceId, pay.userId);
  const [row] = await tx
    .insert(invoices)
    .values({
      number,
      kind: "invoice",
      seq,
      workspaceId: pay.workspaceId,
      paymentId: pay.id,
      trackingCode: trackingCode(),
      paymentRef: pay.refId,
      items: JSON.stringify(items),
      subtotal,
      discount,
      taxPercent: settings.taxPercent,
      taxAmount: tax,
      total: pay.amount,
      test: pay.test || pay.gateway === "sandbox",
      buyer: JSON.stringify(buyer),
      seller: JSON.stringify(seller),
      issuedAt: at,
    })
    .returning();
  return row;
}

/** اعلامیه‌ی بستانکاری (مبلغ منفی) برای بازپرداخت کامل/جزئی؛ فاکتور اصلی در صورت نبود همین‌جا صادر می‌شود */
export async function issueCreditNote(tx: InvoiceExecutor, p: { paymentId: number; amount: number; reason: string; refundedTotal: number; paymentAmount: number }): Promise<InvoiceRow> {
  const original = await issueInvoiceForPayment(tx, p.paymentId);
  if (!original) throw new Error("برای این پرداخت فاکتور قابل صدور نیست");
  const { subtotal, tax } = splitInclusiveTax(-p.amount, original.taxPercent);
  const { seq, number } = await nextSeq(tx, "CN", new Date());
  const [note] = await tx
    .insert(invoices)
    .values({
      number,
      kind: "credit_note",
      seq,
      workspaceId: original.workspaceId,
      paymentId: p.paymentId,
      relatedInvoiceId: original.id,
      status: "issued",
      trackingCode: trackingCode(),
      paymentRef: original.paymentRef,
      items: JSON.stringify([{ title: `بازپرداخت فاکتور ${original.number}${p.reason ? ` — ${p.reason}` : ""}`, qty: 1, amount: -p.amount }] satisfies InvoiceItem[]),
      subtotal,
      discount: 0,
      taxPercent: original.taxPercent,
      taxAmount: tax,
      total: -p.amount,
      test: original.test,
      buyer: original.buyer,
      seller: original.seller,
      note: p.reason || null,
    })
    .returning();
  await tx.update(invoices).set({ status: p.refundedTotal >= p.paymentAmount ? "refunded" : "partially_refunded" }).where(eq(invoices.id, original.id));
  return note;
}

/**
 * ترمیم: پرداخت‌های موفق اشتراک که (به هر دلیل، مثلاً قدیمی بودن) فاکتور ندارند.
 * از زمان‌بند فراخوانی می‌شود؛ هر پرداخت در تراکنش جدا تا خطای یکی بقیه را متوقف نکند.
 */
export async function issueMissingInvoices(limit = 50): Promise<number> {
  const rows = await db.execute(sql`
    select p.id from payments p
    where p.status = 'paid' and p.kind = 'subscription' and p.amount > 0 and p.fulfilled_at is not null
      and not exists (select 1 from invoices i where i.payment_id = p.id and i.kind = 'invoice')
    order by p.id limit ${limit}`);
  let n = 0;
  for (const r of rows.rows as { id: number }[]) {
    try {
      const inv = await db.transaction((tx) => issueInvoiceForPayment(tx, r.id));
      if (inv) n++;
    } catch (e) {
      console.error("[invoice:backfill]", r.id, e instanceof Error ? e.message : e);
    }
  }
  return n;
}

/* ───────────── خواندن ───────────── */

export async function listInvoices(workspaceId: number, limit = 100): Promise<InvoiceRow[]> {
  return db.select().from(invoices).where(eq(invoices.workspaceId, workspaceId)).orderBy(desc(invoices.issuedAt), desc(invoices.id)).limit(limit);
}

export async function getInvoice(id: number): Promise<InvoiceRow | null> {
  if (!Number.isInteger(id)) return null;
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
  return row ?? null;
}

export async function invoiceByPayment(paymentId: number): Promise<InvoiceRow | null> {
  const [row] = await db.select().from(invoices).where(and(eq(invoices.paymentId, paymentId), eq(invoices.kind, "invoice")));
  return row ?? null;
}

const parse = <T,>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
export const invoiceItems = (inv: Pick<InvoiceRow, "items">): InvoiceItem[] => parse<InvoiceItem[]>(inv.items, []);
export const invoiceParties = (inv: Pick<InvoiceRow, "buyer" | "seller">) => ({ buyer: parse<Party>(inv.buyer, { name: "—" }), seller: parse<Party>(inv.seller, { name: "—" }) });

/* ───────────── PDF ───────────── */

const num = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/** HTML امن (همه‌ی مقادیر escape شده) برای موتور PDF فارسی */
export function invoiceHtml(inv: InvoiceRow): string {
  const e = escapeHtml;
  const { buyer, seller } = invoiceParties(inv);
  const isNote = inv.kind === "credit_note";
  const rows = invoiceItems(inv)
    .map((it, i) => `<tr><td>${num(i + 1)}</td><td>${e(it.title)}</td><td>${num(it.qty)}</td><td>${num(it.amount)}</td></tr>`)
    .join("");
  const line = (label: string, value: string) => `<tr><td>${e(label)}</td><td>${value}</td></tr>`;
  const partyRows = (p: Party) =>
    [p.name && `<p><b>${e(p.name)}</b></p>`, p.workspace && p.workspace !== p.name ? `<p>فضای کاری: ${e(p.workspace)}</p>` : "", p.email ? `<p dir="ltr">${e(p.email)}</p>` : "", p.economicCode ? `<p>کد اقتصادی: ${e(p.economicCode)}</p>` : "", p.nationalId ? `<p>شناسه‌ی ملی: ${e(p.nationalId)}</p>` : "", p.address ? `<p>نشانی: ${e(p.address)}</p>` : "", p.phone ? `<p>تلفن: ${e(p.phone)}</p>` : ""].filter(Boolean).join("");
  return `
<h1 style="text-align:center">${isNote ? "اعلامیه‌ی بستانکاری (بازپرداخت)" : "فاکتور رسمی فروش خدمات"}</h1>
${inv.test ? `<p style="text-align:center">«نسخه‌ی آزمایشی — فاقد اعتبار مالی»</p>` : ""}
<table>
<tr><td>شماره‌ی ${isNote ? "اعلامیه" : "فاکتور"}</td><td dir="ltr">${e(inv.number)}</td><td>تاریخ صدور</td><td>${e(fa(inv.issuedAt))}</td></tr>
<tr><td>شماره‌ی پیگیری</td><td dir="ltr">${e(inv.trackingCode)}</td><td>کد پیگیری پرداخت</td><td dir="ltr">${e(inv.paymentRef || "—")}</td></tr>
</table>
<h3>فروشنده</h3>
${partyRows(seller)}
<h3>خریدار</h3>
${partyRows(buyer)}
<h3>اقلام</h3>
<table>
<tr><th>ردیف</th><th>شرح</th><th>تعداد</th><th>مبلغ (تومان)</th></tr>
${rows}
</table>
<h3>جمع‌بندی</h3>
<table>
${line("مبلغ بدون مالیات", `${num(inv.subtotal)} تومان`)}
${line(`مالیات بر ارزش افزوده (${num(inv.taxPercent)}٪ — شامل‌شده در قیمت)`, `${num(inv.taxAmount)} تومان`)}
${line(isNote ? "مبلغ بازپرداخت‌شده" : "مبلغ قابل پرداخت (پرداخت‌شده)", `<b>${num(inv.total)} تومان</b>`)}
</table>
<hr/>
<p>مبالغ ردیف‌ها شامل مالیات بر ارزش افزوده است. این سند به‌صورت الکترونیکی صادر شده و با شماره‌ی پیگیری بالا از طریق پشتیبانی قابل استعلام است.</p>
`;
}

export async function renderInvoicePdf(inv: InvoiceRow): Promise<Buffer> {
  const { renderHtmlDocumentPdf } = await import("@/modules/pdf/render/certificate");
  const { footerNote } = await getInvoiceSettings();
  const html = invoiceHtml(inv) + (footerNote ? `<p>${escapeHtml(footerNote)}</p>` : "");
  return renderHtmlDocumentPdf({ html, title: `${inv.kind === "credit_note" ? "اعلامیه بستانکاری" : "فاکتور"} ${inv.number}`, maxPages: 5 });
}

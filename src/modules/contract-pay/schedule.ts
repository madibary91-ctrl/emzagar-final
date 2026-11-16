/**
 * منطق خالص «برنامه‌ی پرداخت» قرارداد (بدون دیتابیس؛ در سرور و کلاینت مشترک).
 * همه‌ی مبلغ‌ها «تومان»، عدد صحیح. مجموع اقساط همیشه دقیقاً برابر مبلغ کل است (باقیمانده روی آخرین قسط).
 */
export type InstallmentKind = "deposit" | "installment" | "milestone";
export type InstallmentGate = "none" | "before_sign";

export interface PlanItem {
  title: string;
  kind: InstallmentKind;
  amount: number;
  /** ISO (yyyy-mm-dd) یا null = «هنگام امضا» */
  dueAt: string | null;
  gate: InstallmentGate;
  /** 0 = آخرین امضاکننده (مشتری) */
  payerPosition: number;
}

export const MIN_INSTALLMENT = 1000; // حداقل مبلغ پذیرفته‌شده‌ی درگاه‌ها (تومان)
export const MAX_INSTALLMENTS = 36;
export const MAX_TOTAL = 2_000_000_000;

export const KIND_LABELS: Record<InstallmentKind, string> = { deposit: "بیعانه", installment: "قسط", milestone: "پرداخت مرحله‌ای" };

const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";

/** تبدیل «۱٬۵۰۰٬۰۰۰ تومان» / «1,500,000» به عدد صحیح؛ نامعتبر = null */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
  const s = String(raw ?? "")
    .replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)))
    .replace(/[,٬،\s]/g, "")
    .replace(/(تومان|ریال|toman|rial|irt|irr)/gi, "");
  if (!s) return null;
  if (!/^\d{1,13}$/.test(s)) return null;
  return Number(s);
}

export function addDaysISO(base: Date, days: number): string {
  const d = new Date(base.getTime() + days * 86400_000);
  return d.toISOString().slice(0, 10);
}

export interface ScheduleInput {
  total: number;
  /** درصد بیعانه (۰ تا ۹۰) — اگر depositAmount داده شود نادیده گرفته می‌شود */
  depositPercent?: number;
  depositAmount?: number;
  /** تعداد اقساط پس از بیعانه (۰ = یک‌جا) */
  count: number;
  intervalDays: number;
  /** اولین قسط چند روز پس از امروز */
  firstAfterDays?: number;
  /** بیعانه شرط امضا باشد؟ */
  gateDeposit?: boolean;
  payerPosition?: number;
  now?: Date;
}

export type ScheduleResult = { ok: true; items: PlanItem[] } | { ok: false; error: string };

/** ساخت برنامه از «مبلغ کل + بیعانه + تعداد اقساط». مجموع دقیقاً برابر total است. */
export function buildSchedule(inp: ScheduleInput): ScheduleResult {
  const total = Math.round(inp.total);
  if (!Number.isFinite(total) || total < MIN_INSTALLMENT) return { ok: false, error: `مبلغ کل باید دست‌کم ${MIN_INSTALLMENT.toLocaleString("fa-IR")} تومان باشد` };
  if (total > MAX_TOTAL) return { ok: false, error: "مبلغ کل بیش از سقف مجاز است" };
  const count = Math.max(0, Math.min(MAX_INSTALLMENTS, Math.floor(inp.count || 0)));
  const interval = Math.max(1, Math.min(365, Math.floor(inp.intervalDays || 30)));
  const now = inp.now ?? new Date();

  let deposit = 0;
  if (inp.depositAmount !== undefined && inp.depositAmount > 0) deposit = Math.round(inp.depositAmount);
  else if (inp.depositPercent && inp.depositPercent > 0) {
    if (inp.depositPercent > 90) return { ok: false, error: "درصد بیعانه حداکثر ۹۰ است" };
    deposit = Math.round((total * inp.depositPercent) / 100);
  }
  if (deposit >= total) return { ok: false, error: "بیعانه باید کمتر از مبلغ کل باشد" };
  if (deposit > 0 && deposit < MIN_INSTALLMENT) return { ok: false, error: `بیعانه باید دست‌کم ${MIN_INSTALLMENT.toLocaleString("fa-IR")} تومان باشد` };

  const rest = total - deposit;
  const payer = inp.payerPosition ?? 0;
  const items: PlanItem[] = [];
  if (deposit > 0) items.push({ title: "بیعانه", kind: "deposit", amount: deposit, dueAt: null, gate: inp.gateDeposit ? "before_sign" : "none", payerPosition: payer });

  const n = count === 0 ? 1 : count;
  const base = Math.floor(rest / n);
  if (base < MIN_INSTALLMENT) return { ok: false, error: `هر قسط باید دست‌کم ${MIN_INSTALLMENT.toLocaleString("fa-IR")} تومان باشد؛ تعداد اقساط را کمتر کنید` };
  const first = Math.max(0, Math.min(365, Math.floor(inp.firstAfterDays ?? interval)));
  for (let i = 0; i < n; i++) {
    const amount = i === n - 1 ? rest - base * (n - 1) : base;
    const single = count === 0;
    items.push({
      title: single ? (deposit > 0 ? "تسویه‌ی مانده" : "پرداخت کامل") : `قسط ${i + 1} از ${n}`,
      kind: "installment",
      amount,
      dueAt: addDaysISO(now, first + i * interval),
      gate: !deposit && single && inp.gateDeposit ? "before_sign" : "none",
      payerPosition: payer,
    });
  }
  return { ok: true, items };
}

export type ValidateResult = { ok: true; items: PlanItem[]; total: number } | { ok: false; error: string };

/** اعتبارسنجی برنامه‌ی دستی/ورودی کلاینت؛ هرگز به ورودی اعتماد نمی‌شود. */
export function validatePlan(raw: unknown): ValidateResult {
  if (!Array.isArray(raw)) return { ok: false, error: "برنامه‌ی پرداخت نامعتبر است" };
  if (raw.length === 0) return { ok: false, error: "دست‌کم یک ردیف پرداخت لازم است" };
  if (raw.length > MAX_INSTALLMENTS + 1) return { ok: false, error: `حداکثر ${MAX_INSTALLMENTS + 1} ردیف پرداخت مجاز است` };
  const items: PlanItem[] = [];
  let total = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = (raw[i] ?? {}) as Record<string, unknown>;
    const amount = parseAmount(r.amount);
    const title = String(r.title ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!title) return { ok: false, error: `عنوان ردیف ${i + 1} را وارد کنید` };
    if (amount === null || amount < MIN_INSTALLMENT) return { ok: false, error: `مبلغ «${title}» باید دست‌کم ${MIN_INSTALLMENT.toLocaleString("fa-IR")} تومان باشد` };
    const kind: InstallmentKind = r.kind === "deposit" || r.kind === "milestone" ? r.kind : "installment";
    let dueAt: string | null = null;
    if (r.dueAt !== null && r.dueAt !== undefined && String(r.dueAt).trim() !== "") {
      const s = String(r.dueAt).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())) return { ok: false, error: `تاریخ «${title}» نامعتبر است` };
      dueAt = s;
    }
    const pp = Number(r.payerPosition);
    const payerPosition = Number.isInteger(pp) && pp >= 0 && pp <= 20 ? pp : 0;
    items.push({ title, kind, amount, dueAt, gate: r.gate === "before_sign" ? "before_sign" : "none", payerPosition });
    total += amount;
  }
  if (total > MAX_TOTAL) return { ok: false, error: "مجموع مبلغ‌ها بیش از سقف مجاز است" };
  return { ok: true, items, total };
}

/* ───────── جدول داخل متن قرارداد (بخشی از سند امضاشده و هش آن) ───────── */
const HEAD = "جدول تعهدات مالی";
const BLOCK_RE = /<h3>\s*جدول تعهدات مالی\s*<\/h3>[\s\S]*?<\/table>/;

const fmt = (n: number) => n.toLocaleString("fa-IR");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const faDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("fa-IR-u-ca-persian", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

export function scheduleHtml(items: PlanItem[]): string {
  const total = items.reduce((s, i) => s + i.amount, 0);
  const rows = items
    .map(
      (it, i) =>
        `<tr><td>${fmt(i + 1)}</td><td>${esc(it.title)}${it.gate === "before_sign" ? " (پیش‌شرط امضا)" : ""}</td><td>${fmt(it.amount)} تومان</td><td>${it.dueAt ? faDate(it.dueAt) : "هنگام امضا"}</td></tr>`,
    )
    .join("");
  return `<h3>${HEAD}</h3><p>طرفین متعهد می‌شوند مبالغ زیر را مطابق برنامه‌ی زمانی پرداخت کنند. مبلغ کل: ${fmt(total)} تومان.</p><table><thead><tr><th>ردیف</th><th>عنوان</th><th>مبلغ</th><th>سررسید</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** جدول پرداخت را در متن قرارداد درج یا جایگزین می‌کند (idempotent) */
export function withScheduleBlock(bodyHtml: string, items: PlanItem[] | null): string {
  const stripped = bodyHtml.replace(BLOCK_RE, "").trimEnd();
  return items && items.length ? `${stripped}${scheduleHtml(items)}` : stripped;
}

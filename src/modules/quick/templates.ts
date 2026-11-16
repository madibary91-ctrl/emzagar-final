/**
 * قالب‌های «ارسال سریع»: فقط چند جای خالی پر می‌شود و متن کامل ساخته می‌شود (بدون نیاز به دانش حقوقی یا ویرایشگر).
 * کلاینت‌-سیف (بدون وابستگی سرور). مقدارها HTML-escape می‌شوند؛ سرور هم دوباره پاک‌سازی می‌کند.
 */
export interface QuickField {
  key: string;
  label: string;
  placeholder?: string;
  kind?: "text" | "textarea";
}
export interface QuickCtx {
  sender: string;
  recipient: string;
  today: string;
}
export interface QuickTemplate {
  id: string;
  title: string;
  hint: string;
  emoji: string;
  fields: QuickField[];
  /** متن کامل (HTML) */
  build: (v: Record<string, string>, c: QuickCtx) => string;
}

const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const val = (v: Record<string, string>, k: string, dflt = "…………") => esc((v[k] ?? "").trim() || dflt).replace(/\n/g, "<br>");

const parties = (c: QuickCtx, a: string, b: string) => `<p><b>${a}:</b> ${esc(c.sender)}</p><p><b>${b}:</b> ${esc(c.recipient)}</p>`;

export const QUICK_TEMPLATES: QuickTemplate[] = [
  {
    id: "receipt",
    title: "رسید دریافت وجه",
    hint: "پول گرفتید یا دادید؟ رسیدش را همین‌جا امضا کنید",
    emoji: "🧾",
    fields: [
      { key: "amount", label: "مبلغ (تومان)", placeholder: "مثلاً ۵۰٬۰۰۰٬۰۰۰" },
      { key: "reason", label: "بابت", placeholder: "مثلاً پیش‌پرداخت طراحی سایت" },
    ],
    build: (v, c) =>
      `<h2>رسید دریافت وجه</h2><p>تاریخ: ${esc(c.today)}</p>${parties(c, "دریافت‌کننده", "پرداخت‌کننده")}<p>دریافت‌کننده اقرار می‌کند مبلغ <b>${val(v, "amount")} تومان</b> بابت <b>${val(v, "reason")}</b> را از پرداخت‌کننده به‌طور کامل دریافت کرده است.</p><p>هر دو طرف با امضای این رسید، دریافت و پرداخت مبلغ فوق را تأیید می‌کنند.</p>`,
  },
  {
    id: "loan",
    title: "قرض / وام شخصی",
    hint: "مبلغ و موعد بازپرداخت روشن و مستند شود",
    emoji: "🤝",
    fields: [
      { key: "amount", label: "مبلغ قرض (تومان)" },
      { key: "due", label: "موعد بازپرداخت", placeholder: "مثلاً ۱۴۰۵/۱۲/۲۹" },
      { key: "method", label: "نحوه‌ی بازپرداخت", placeholder: "یکجا / ماهانه ۵ میلیون" },
    ],
    build: (v, c) =>
      `<h2>قرارداد قرض</h2><p>تاریخ: ${esc(c.today)}</p>${parties(c, "قرض‌دهنده", "قرض‌گیرنده")}<ol><li>قرض‌دهنده مبلغ <b>${val(v, "amount")} تومان</b> را به قرض‌گیرنده قرض داده و قرض‌گیرنده آن را تحویل گرفته است.</li><li>قرض‌گیرنده متعهد است مبلغ را حداکثر تا تاریخ <b>${val(v, "due")}</b> و به شکل <b>${val(v, "method", "یکجا")}</b> بازپرداخت کند.</li><li>این قرض بدون بهره (قرض‌الحسنه) است مگر آنکه طرفین کتباً غیر آن را توافق کنند.</li><li>در صورت تأخیر، قرض‌دهنده می‌تواند طبق قوانین جاری برای وصول طلب خود اقدام کند.</li></ol>`,
  },
  {
    id: "nda",
    title: "تعهدنامه‌ی محرمانگی (NDA)",
    hint: "پیش از افشای اطلاعات حساس به شریک یا پیمانکار",
    emoji: "🔒",
    fields: [
      { key: "subject", label: "موضوع اطلاعات محرمانه", placeholder: "مثلاً کد منبع و فهرست مشتریان پروژه‌ی الف" },
      { key: "years", label: "مدت تعهد (سال)", placeholder: "۲" },
    ],
    build: (v, c) =>
      `<h2>تعهدنامه‌ی محرمانگی</h2><p>تاریخ: ${esc(c.today)}</p>${parties(c, "افشاکننده", "دریافت‌کننده")}<ol><li>موضوع: اطلاعات مرتبط با <b>${val(v, "subject")}</b> که افشاکننده در اختیار دریافت‌کننده قرار می‌دهد، محرمانه تلقی می‌شود.</li><li>دریافت‌کننده متعهد است اطلاعات را فقط برای هدف توافق‌شده به‌کار ببرد و آن را بدون اجازه‌ی کتبی به هیچ شخص ثالثی افشا یا کپی نکند.</li><li>این تعهد به مدت <b>${val(v, "years", "۲")} سال</b> از تاریخ امضا معتبر است و با پایان همکاری هم ادامه دارد.</li><li>نقض این تعهد، دریافت‌کننده را مسئول جبران کامل خسارات وارده می‌کند.</li></ol>`,
  },
  {
    id: "rent",
    title: "اجاره‌نامه‌ی ساده",
    hint: "ملک، مبلغ و مدت — در چند دقیقه",
    emoji: "🏠",
    fields: [
      { key: "address", label: "نشانی ملک", kind: "textarea" },
      { key: "rent", label: "اجاره‌بهای ماهانه (تومان)" },
      { key: "deposit", label: "مبلغ ودیعه/رهن (تومان)" },
      { key: "start", label: "تاریخ شروع", placeholder: "۱۴۰۵/۰۳/۰۱" },
      { key: "months", label: "مدت اجاره (ماه)", placeholder: "۱۲" },
    ],
    build: (v, c) =>
      `<h2>قرارداد اجاره</h2><p>تاریخ: ${esc(c.today)}</p>${parties(c, "موجر", "مستأجر")}<ol><li>موجر ملک واقع در <b>${val(v, "address")}</b> را به مستأجر اجاره داده است.</li><li>مدت اجاره <b>${val(v, "months", "۱۲")} ماه</b> از تاریخ <b>${val(v, "start")}</b> است.</li><li>اجاره‌بهای ماهانه <b>${val(v, "rent")} تومان</b> و مبلغ ودیعه <b>${val(v, "deposit")} تومان</b> است که در پایان مدت و پس از تخلیه و تحویل ملک بازگردانده می‌شود.</li><li>مستأجر ملک را در حد متعارف نگهداری می‌کند و حق انتقال به غیر را ندارد؛ هزینه‌های مصرف (آب، برق، گاز) با مستأجر است.</li></ol>`,
  },
  {
    id: "service",
    title: "قرارداد انجام کار / پروژه",
    hint: "فریلنسر، پیمانکار یا خدمات — دامنه، مبلغ، موعد",
    emoji: "🛠️",
    fields: [
      { key: "scope", label: "شرح کار", kind: "textarea", placeholder: "چه کاری باید انجام شود؟" },
      { key: "fee", label: "دستمزد (تومان)" },
      { key: "deadline", label: "موعد تحویل", placeholder: "۱۴۰۵/۰۴/۳۱" },
      { key: "payment", label: "نحوه‌ی پرداخت", placeholder: "۵۰٪ پیش‌پرداخت، ۵۰٪ هنگام تحویل" },
    ],
    build: (v, c) =>
      `<h2>قرارداد انجام کار</h2><p>تاریخ: ${esc(c.today)}</p>${parties(c, "کارفرما", "مجری")}<ol><li>شرح کار: ${val(v, "scope")}</li><li>دستمزد توافق‌شده <b>${val(v, "fee")} تومان</b> و نحوه‌ی پرداخت: <b>${val(v, "payment")}</b>.</li><li>مجری متعهد است کار را تا تاریخ <b>${val(v, "deadline")}</b> تحویل دهد.</li><li>تغییر در دامنه‌ی کار یا موعد، فقط با توافق کتبی هر دو طرف معتبر است.</li><li>هر دو طرف متعهد به حفظ اطلاعات محرمانه‌ی یکدیگرند.</li></ol>`,
  },
  {
    id: "consent",
    title: "رضایت‌نامه / تعهدنامه",
    hint: "رضایت یا تعهد یک‌طرفه‌ی طرف مقابل",
    emoji: "✅",
    fields: [{ key: "text", label: "متن رضایت یا تعهد", kind: "textarea", placeholder: "مثلاً اینجانب رضایت می‌دهم تصاویر من در شبکه‌های اجتماعی باشگاه منتشر شود." }],
    build: (v, c) => `<h2>رضایت‌نامه / تعهدنامه</h2><p>تاریخ: ${esc(c.today)}</p>${parties(c, "درخواست‌کننده", "امضاکننده")}<p>${val(v, "text")}</p><p>امضاکننده با امضای این سند، مفاد بالا را مطالعه کرده و می‌پذیرد.</p>`,
  },
  {
    id: "free",
    title: "متن دلخواه",
    hint: "متن خودتان را بنویسید یا بچسبانید",
    emoji: "✍️",
    fields: [{ key: "text", label: "متن سند", kind: "textarea", placeholder: "متن توافق یا سند را اینجا بنویسید…" }],
    build: (v, c) => `<p>تاریخ: ${esc(c.today)}</p>${parties(c, "طرف اول", "طرف دوم")}<p>${val(v, "text", "")}</p>`,
  },
];

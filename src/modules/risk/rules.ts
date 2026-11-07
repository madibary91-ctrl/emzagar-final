/**
 * موتور قواعد تحلیل ریسک قرارداد فارسی (بدون وابستگی به سرور و بدون هزینه).
 * بندهای ضروری ناقص، عبارت‌های یک‌طرفه، جریمه‌های سنگین، جاهای خالی و … را شناسایی می‌کند.
 * این ابزار جایگزین مشاوره‌ی حقوقی نیست.
 */
export type Severity = "high" | "medium" | "low" | "info";
export type Level = "low" | "medium" | "high" | "critical";

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  suggestion: string;
  /** بخشی از متن قرارداد که مشکل در آن دیده شده است */
  quote?: string;
  source: "rules" | "ai";
}

export interface RiskResult {
  score: number;
  level: Level;
  summary: string;
  findings: Finding[];
  /** بندهای مهم که در متن یافت نشدند */
  missing: string[];
  /** بندهایی که در متن شناسایی شدند */
  present: string[];
  wordCount: number;
}

export const LEVEL_LABELS: Record<Level, string> = { low: "کم‌ریسک", medium: "ریسک متوسط", high: "پرریسک", critical: "بحرانی" };
export const SEVERITY_LABELS: Record<Severity, string> = { high: "ریسک بالا", medium: "ریسک متوسط", low: "ریسک پایین", info: "پیشنهاد" };

/** یکسان‌سازی متن: حذف تگ، حروف عربی→فارسی، ارقام فارسی/عربی→لاتین، نیم‌فاصله→فاصله */
export function normalizeText(input: string): string {
  return input
    .replace(/<\s*(br|\/p|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/ك/g, "ک")
    .replace(/[يى]/g, "ی")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u200c/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const CLAUSES: { id: string; label: string; re: RegExp; severity: Severity; why: string; fix: string }[] = [
  { id: "parties", label: "مشخصات طرفین", re: /کد ملی|شماره ملی|شناسه ملی|نشانی|آدرس|محل سکونت|شماره ثبت|کد پستی/, severity: "medium", why: "مشخصات هویتی و نشانی طرفین در متن دیده نمی‌شود؛ ابلاغ و اثبات هویت دشوار می‌شود.", fix: "نام کامل، کد/شناسه ملی و نشانی قانونی هر طرف را در ابتدای قرارداد بیاورید." },
  { id: "subject", label: "موضوع قرارداد", re: /موضوع قرارداد|موضوع این قرارداد|موضوع:|ماده\s*1\s*[-—:]?\s*موضوع/, severity: "high", why: "موضوع قرارداد به‌صراحت تعریف نشده است؛ دامنه‌ی تعهدات مبهم می‌ماند.", fix: "یک ماده‌ی مستقل با عنوان «موضوع قرارداد» و شرح دقیق خدمات/کالا اضافه کنید." },
  { id: "payment", label: "مبلغ و نحوه پرداخت", re: /مبلغ|پرداخت|ریال|تومان|حق ?الزحمه|بها|هزینه/, severity: "medium", why: "مبلغ یا شرایط پرداخت مشخص نشده است.", fix: "مبلغ کل، زمان‌بندی اقساط/مراحل و روش پرداخت را به‌صورت عددی و حروفی بنویسید." },
  { id: "duration", label: "مدت و تاریخ اجرا", re: /مدت (این )?قرارداد|مدت اعتبار|تاریخ شروع|تاریخ پایان|از تاریخ|لغایت|تا تاریخ|به مدت/, severity: "medium", why: "مدت یا تاریخ شروع/پایان قرارداد ذکر نشده است.", fix: "تاریخ شروع، مدت و شرایط تمدید را صریح بنویسید." },
  { id: "termination", label: "شرایط فسخ و خاتمه", re: /فسخ|خاتمه (قرارداد|همکاری)|انحلال|اقاله/, severity: "medium", why: "راه خروج از قرارداد (فسخ/خاتمه) و مهلت اخطار مشخص نشده است.", fix: "حالت‌های فسخ، مهلت اخطار کتبی و آثار مالی فسخ را مشخص کنید." },
  { id: "dispute", label: "حل اختلاف و مرجع صالح", re: /حل اختلاف|داوری|مرجع صالح|دادگاه|مراجع قضایی|مرجع رسیدگی/, severity: "high", why: "مرجع و شیوه‌ی حل اختلاف تعیین نشده است؛ در بروز اختلاف، رسیدگی طولانی و پرهزینه می‌شود.", fix: "مذاکره‌ی دوستانه ← داوری یا دادگاه مشخص (شهر) را به‌ترتیب ذکر کنید." },
  { id: "confidential", label: "محرمانگی", re: /محرمانه|افشا|اسرار/, severity: "medium", why: "تعهد به محرمانگی اطلاعات دیده نمی‌شود.", fix: "ماده‌ای برای حفظ اسرار تجاری و مدت پایبندی پس از پایان قرارداد اضافه کنید." },
  { id: "force", label: "فورس ماژور (قوه قاهره)", re: /فورس ماژور|force majeure|قوه قاهره|حوادث غیر ?مترقبه|امر خارج از اراده/, severity: "medium", why: "وضعیت حوادث غیرمترقبه (جنگ، بلایا، قطعی گسترده‌ی اینترنت و …) پیش‌بینی نشده است.", fix: "بند فورس ماژور با تعریف مصادیق، مهلت اطلاع‌رسانی و آثار آن اضافه کنید." },
  { id: "penalty", label: "وجه التزام / خسارت تاخیر", re: /وجه التزام|جریمه|خسارت تاخیر|خسارت/, severity: "low", why: "ضمانت اجرای تاخیر یا نقض تعهد (جریمه/خسارت) پیش‌بینی نشده است.", fix: "برای تاخیر یا نقض، یک وجه التزام متعادل با سقف مشخص تعیین کنید." },
  { id: "ip", label: "مالکیت فکری", re: /مالکیت (فکری|معنوی)|حق نشر|کپی ?رایت|حقوق مادی و معنوی/, severity: "low", why: "مالکیت آثار تولیدشده (کد، طرح، محتوا) مشخص نشده است.", fix: "مشخص کنید حقوق مادی و معنوی خروجی‌ها پس از تسویه به چه کسی منتقل می‌شود." },
  { id: "copies", label: "نسخه‌ها و اعتبار", re: /نسخه|اعتبار یکسان|لازم الاجرا|لازم‌الاجرا/, severity: "low", why: "تعداد نسخه‌ها و اعتبار یکسان آن‌ها ذکر نشده است.", fix: "در پایان، تعداد نسخه‌ها و اعتبار یکسان آن‌ها را بنویسید." },
];

function pick(text: string, re: RegExp, radius = 70): string | undefined {
  const m = re.exec(text);
  if (!m) return undefined;
  const a = Math.max(0, m.index - radius);
  const b = Math.min(text.length, m.index + m[0].length + radius);
  return `${a > 0 ? "…" : ""}${text.slice(a, b).replace(/\s+/g, " ").trim()}${b < text.length ? "…" : ""}`;
}

const WEIGHT: Record<Severity, number> = { high: 16, medium: 8, low: 3, info: 0 };

export function levelFor(score: number): Level {
  return score < 25 ? "low" : score < 50 ? "medium" : score < 75 ? "high" : "critical";
}

export function scoreFindings(findings: Finding[]): number {
  return Math.min(100, findings.reduce((s, f) => s + WEIGHT[f.severity], 0));
}

export function analyzeByRules(html: string): RiskResult {
  const text = normalizeText(html);
  const words = text.split(/\s+/).filter(Boolean).length;
  const findings: Finding[] = [];
  const missing: string[] = [];
  const present: string[] = [];

  // ── بندهای ضروری ──
  for (const c of CLAUSES) {
    if (c.re.test(text)) present.push(c.label);
    else {
      missing.push(c.label);
      findings.push({ severity: c.severity, title: `بند «${c.label}» یافت نشد`, detail: c.why, suggestion: c.fix, source: "rules" });
    }
  }

  // ── الگوهای پرخطر ──
  const risky: { re: RegExp; severity: Severity; title: string; detail: string; fix: string }[] = [
    { re: /به صلاحدید|یک ?طرفه|بدون (نیاز به )?(اطلاع|اخطار|رضایت)|هر زمان که (بخواهد|بخواهند|صلاح بداند)|حق (هرگونه )?اعتراض ندارد|بدون هیچ ?گونه (قید|اعتراض)|مختار است/, severity: "high", title: "اختیار یک‌طرفه", detail: "عبارتی دیده شد که اختیار یا حق را به یک طرف می‌دهد و طرف مقابل را از اعتراض یا اطلاع محروم می‌کند.", fix: "حقوق را دوطرفه کنید یا اعمال اختیار را به اخطار کتبی و دلیل موجه مشروط کنید." },
    { re: /تمدید خودکار|به طور خودکار تمدید|خود ?به ?خود تمدید|تمدید می ?شود/, severity: "medium", title: "تمدید خودکار قرارداد", detail: "قرارداد بدون اقدام جدید تمدید می‌شود و ممکن است طرفین ناخواسته متعهد بمانند.", fix: "مهلت اعلام عدم تمدید (مثلاً ۳۰ روز پیش از پایان) را صریحاً بنویسید." },
    { re: /ممنوعیت رقابت|عدم رقابت|انحصاری|حق انحصار/, severity: "medium", title: "بند انحصار یا عدم رقابت", detail: "محدودیت رقابتی/انحصاری می‌تواند فعالیت آینده‌ی یک طرف را به‌شدت محدود کند.", fix: "دامنه‌ی موضوعی، جغرافیایی و مدت زمان محدودیت را محدود و مشخص کنید." },
    { re: /مسئولیت نامحدود|(جبران|پرداخت) (کلیه|تمام|هرگونه) خسارات?|کلیه خسارات (وارده|احتمالی)/, severity: "medium", title: "مسئولیت و خسارت بدون سقف", detail: "جبران «کلیه خسارات» بدون سقف می‌تواند پیامد مالی سنگین و غیرقابل پیش‌بینی داشته باشد.", fix: "سقف مسئولیت (مثلاً معادل مبلغ قرارداد) و استثناهای آن را تعیین کنید." },
    { re: /(بدون (هیچ )?(ضمانت|مسئولیت))|مسئولیتی (ندارد|ندارند|نخواهد داشت)|سلب مسئولیت/, severity: "medium", title: "سلب کامل مسئولیت", detail: "نفی کامل مسئولیت یک طرف ممکن است طبق قانون قابل استناد نباشد و اعتماد را کاهش دهد.", fix: "به‌جای سلب کامل، حدود مسئولیت را مشخص کنید." },
  ];
  for (const r of risky) {
    const q = pick(text, r.re);
    if (q) findings.push({ severity: r.severity, title: r.title, detail: r.detail, suggestion: r.fix, quote: q, source: "rules" });
  }

  // ── جریمه‌ی سنگین: درصد در نزدیکی کلمات جریمه/خسارت ──
  const penRe = /(جریمه|وجه التزام|خسارت)[^.\n]{0,60}?(\d+(?:\.\d+)?)\s*(?:درصد|٪|%)|(\d+(?:\.\d+)?)\s*(?:درصد|٪|%)[^.\n]{0,60}?(جریمه|وجه التزام|خسارت)/g;
  let pm: RegExpExecArray | null;
  let worst = 0;
  let worstQuote = "";
  while ((pm = penRe.exec(text))) {
    const v = Number(pm[2] ?? pm[3]);
    const ctx = text.slice(Math.max(0, pm.index - 20), pm.index + pm[0].length + 40);
    const perDay = /روزانه|هر روز|در روز|هر هفته|هفتگی/.test(ctx);
    const eff = perDay ? v * 10 : v;
    if (eff > worst) {
      worst = eff;
      worstQuote = ctx.replace(/\s+/g, " ").trim();
    }
  }
  if (worst >= 30) findings.push({ severity: "high", title: "جریمه یا خسارت بسیار سنگین", detail: "درصد جریمه/خسارت بیش از حد متعارف است و ممکن است دادگاه آن را تعدیل کند یا موجب اختلاف شود.", suggestion: "جریمه را با سقف مشخص (مثلاً حداکثر ۱۰ تا ۲۰ درصد مبلغ قرارداد) و به‌صورت متناسب تعیین کنید.", quote: worstQuote, source: "rules" });
  else if (worst >= 10) findings.push({ severity: "medium", title: "جریمه یا خسارت قابل‌توجه", detail: "درصد جریمه/خسارت نسبتاً بالاست.", suggestion: "سقف کل جریمه را مشخص کنید و تناسب آن با زیان واقعی را بررسی کنید.", quote: worstQuote, source: "rules" });
  if (/جریمه|وجه التزام/.test(text) && !/سقف|حداکثر|تا سقف/.test(text)) {
    findings.push({ severity: "low", title: "جریمه بدون سقف", detail: "برای جریمه‌ی تاخیر، سقف نهایی تعیین نشده است.", suggestion: "عبارت «حداکثر تا … درصد مبلغ قرارداد» را اضافه کنید.", source: "rules" });
  }

  // ── جاهای خالی و متغیرهای پر‌نشده ──
  const blanks = (text.match(/…{2,}|\.{4,}|_{3,}|…\s*…/g) ?? []).length;
  if (blanks > 0) findings.push({ severity: blanks >= 3 ? "high" : "medium", title: `${blanks} جای خالی تکمیل‌نشده`, detail: "در متن جاهای خالی (……) وجود دارد که اگر پر نشود قرارداد ناقص و قابل مناقشه خواهد بود.", suggestion: "پیش از ارسال برای امضا، همه‌ی جاهای خالی را تکمیل کنید.", quote: pick(text, /…{2,}|\.{4,}|_{3,}/), source: "rules" });
  const vars = text.match(/\[[A-Z][A-Z_]{2,}\]/g);
  if (vars?.length) findings.push({ severity: "medium", title: "متغیر جایگزین‌نشده", detail: `متغیرهای ${[...new Set(vars)].slice(0, 4).join("، ")} هنوز با مقدار واقعی جایگزین نشده‌اند (اگر این متن «قالب» است، طبیعی است).`, suggestion: "پیش از صدور، متغیرها را بررسی کنید؛ سامانه هنگام صدور آن‌ها را پر می‌کند.", source: "rules" });

  // ── ابهام زبانی ──
  const vague = (text.match(/در اسرع وقت|به مقدار کافی|مناسب|معقول|متعارف|به موقع|حتی الامکان|تا حد امکان/g) ?? []).length;
  if (vague >= 3) findings.push({ severity: "low", title: "عبارت‌های مبهم و غیرقابل‌اندازه‌گیری", detail: `${vague} عبارت کلی مانند «در اسرع وقت» یا «معقول» دیده شد که در اختلاف قابل تفسیر متفاوت‌اند.`, suggestion: "عبارت‌های کلی را با مهلت و معیار عددی (مثلاً «ظرف ۷ روز کاری») جایگزین کنید.", source: "rules" });

  if (words < 120) findings.push({ severity: "medium", title: "متن بسیار کوتاه", detail: `متن فقط حدود ${words} کلمه دارد و احتمالاً شرایط مهم را پوشش نمی‌دهد.`, suggestion: "بندهای ضروری (فسخ، حل اختلاف، محرمانگی، …) را اضافه کنید.", source: "rules" });

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const score = scoreFindings(findings);
  const high = findings.filter((f) => f.severity === "high").length;
  const summary =
    words < 20
      ? "متن برای تحلیل کافی نیست."
      : `${present.length} از ${CLAUSES.length} بند کلیدی در متن شناسایی شد. ${high > 0 ? `${high} مورد پرریسک نیازمند بازبینی فوری است.` : "مورد پرریسک بحرانی یافت نشد."}`;
  return { score, level: levelFor(score), summary, findings, missing, present, wordCount: words };
}

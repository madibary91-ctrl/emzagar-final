import type { LibraryTemplate, TemplateSpec } from "./types";

/* ───────── جاهای خالی صادرکننده: ((کلید|عنوان)) ───────── */

export const PLACEHOLDER_RE = /\(\(([a-z][a-z0-9_]{0,31})\|([^()|]{1,90})\)\)/g;
export const BLANK = "……………";

export interface Placeholder {
  key: string;
  label: string;
}

/** فهرست یکتای جاهای خالی به ترتیب ظهور در متن */
export function listPlaceholders(body: string): Placeholder[] {
  const seen = new Map<string, Placeholder>();
  for (const m of body.matchAll(PLACEHOLDER_RE)) if (!seen.has(m[1])) seen.set(m[1], { key: m[1], label: m[2].trim() });
  return [...seen.values()];
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** مقدارها را (با escape کامل) جایگزین می‌کند؛ جای خالی‌مانده به «……» تبدیل می‌شود تا هیچ نشانه‌ی فنی در قرارداد نماند */
export function fillPlaceholders(body: string, values: Record<string, string | undefined> = {}): string {
  return body.replace(PLACEHOLDER_RE, (_m, key: string) => {
    const v = String(values[key] ?? "")
      .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    return v ? `<strong>${esc(v)}</strong>` : BLANK;
  });
}

/* ───────── بندهای استاندارد مشترک ───────── */

const DISPUTE: [string, ...string[]] = [
  "حل اختلاف و مرجع صالح",
  "هرگونه اختلاف ناشی از تفسیر یا اجرای این قرارداد، ابتدا از راه مذاکره و تفاهم دوستانه و حداکثر ظرف پانزده روز از تاریخ اعلام کتبی اختلاف حل‌وفصل می‌شود.",
  "در صورت عدم حصول توافق، هر یک از طرفین می‌تواند به مراجع قضایی صالح در شهر ((court_city|شهر دادگاه صالح)) مراجعه کند. هزینه‌ی دادرسی و حق‌الوکاله‌ی وکیل مطابق حکم دادگاه به عهده‌ی محکوم‌علیه خواهد بود.",
];

const FORCE_MAJEURE: [string, ...string[]] = [
  "قوه‌ی قاهره",
  "هرگاه اجرای تعهدات به سبب حوادث خارج از اراده و پیش‌بینی طرفین (از قبیل زلزله، سیل، جنگ، حکم مراجع قانونی یا قطع گسترده‌ی زیرساخت‌ها) غیرممکن یا موقتاً متوقف شود، به استناد مواد ۲۲۷ و ۲۲۹ قانون مدنی، طرف متأثر مسئول خسارت نیست؛ مشروط بر آنکه ظرف هفت روز، رویداد را کتباً به طرف مقابل اطلاع دهد و پس از رفع آن، تعهد خود را بی‌درنگ از سر بگیرد.",
];

const NOTICES: [string, ...string[]] = [
  "نشانی قانونی، ابلاغ و اصلاحات",
  "نشانی و شماره‌ی تماس طرفین همان است که در مقدمه‌ی قرارداد آمده است و کلیه‌ی مکاتبات، اخطارها و ابلاغ‌ها به همان نشانی (و پیامک به شماره‌ی همراه مندرج) معتبر و ابلاغ‌شده تلقی می‌شود. تغییر نشانی باید ظرف هفت روز کتباً به طرف مقابل اعلام شود، و گرنه ابلاغ به نشانی قبلی قانونی است.",
  "هرگونه تغییر یا الحاق به این قرارداد تنها با توافق کتبی و به امضای هر دو طرف معتبر است. بی‌اعتباری یا بطلان هر ماده، به اعتبار سایر مواد خللی وارد نمی‌کند.",
];

const ESIGN: [string, ...string[]] = [
  "امضای الکترونیکی و نسخه‌ها",
  "طرفین اذعان دارند که این قرارداد با امضای الکترونیکی و پس از احراز هویت از راه لینک اختصاصی و رمز یک‌بارمصرف پیامکی منعقد شده است و بر پایه‌ی مواد ۷ و ۱۵ قانون تجارت الکترونیکی مصوب ۱۳۸۲، دارای اعتبار و آثار حقوقی امضای دستی است و هیچ‌یک از طرفین حق انکار یا تردید در آن را ندارد. زمان، نشانی اینترنتی (IP) و اثر انگشت دیجیتال سند در شناسنامه‌ی قرارداد ثبت و قابل استعلام است.",
  "این قرارداد در دو نسخه‌ی الکترونیکی با اعتبار واحد تنظیم و پس از امضای همه‌ی طرفین، نسخه‌ی PDF رسمی آن برای طرفین قابل دریافت است. طرفین با علم و اختیار و با اراده‌ی آزاد و با رعایت شرایط اساسی صحت معاملات (ماده ۱۹۰ قانون مدنی) آن را امضا می‌کنند.",
];

/* ───────── ساخت HTML ───────── */

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const faNum = (n: number) => String(n).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);

function renderParagraphs(items: string[], roles: [string, string]): string {
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${li}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const raw of items) {
    const t = raw.replaceAll("{A}", roles[0]).replaceAll("{B}", roles[1]);
    if (t.startsWith("- ")) list.push(t.slice(2));
    else {
      flush();
      out.push(`<p>${t}</p>`);
    }
  }
  flush();
  return out.join("");
}

function partiesBlock(spec: TemplateSpec): string {
  const [r1, r2] = spec.roles;
  const parts: string[] = [];
  parts.push(
    `<p><strong>طرف اول:</strong> ((p1_name|نام و نام خانوادگی یا عنوان شخص حقوقی ${r1})) دارای کد ملی/شناسه‌ی ملی ((p1_nid|کد ملی یا شناسه‌ی ملی ${r1})) به نشانی ((p1_address|نشانی کامل ${r1})) و شماره‌ی تماس ((p1_mobile|تلفن همراه ${r1})) که در این قرارداد «${r1}» نامیده می‌شود.</p>`,
  );
  (spec.extraSigners ?? []).forEach((label, i) => {
    const n = i + 1;
    parts.push(
      `<p><strong>${label}:</strong> {{field:s${n}_name|نام و نام خانوادگی ${label}|text|req|${n}}} دارای کد ملی {{field:s${n}_nid|کد ملی ${label}|nid|req|${n}}} به نشانی {{field:s${n}_address|نشانی ${label}|address|req|${n}}} و شماره‌ی تماس {{field:s${n}_phone|تلفن همراه ${label}|phone|req|${n}}} که در این قرارداد «${label}» نامیده می‌شود.</p>`,
    );
  });
  const extra = (spec.p2Fields ?? []).map(([k, label, type]) => ` ${label}: {{field:${k}|${label}|${type}}}`).join("،");
  parts.push(
    `<p><strong>طرف ${(spec.extraSigners ?? []).length ? "آخر" : "دوم"}:</strong> [USER_NAME] دارای کد ملی {{field:p2_nid|کد ملی|nid}} به نشانی {{field:p2_address|نشانی کامل|address}} و شماره‌ی تماس [USER_MOBILE]${extra ? `،${extra}،` : ""} که در این قرارداد «${r2}» نامیده می‌شود.</p>`,
  );
  return parts.join("");
}

export function buildTemplate(spec: TemplateSpec): LibraryTemplate {
  const articles: Array<[string, ...string[]]> = [...spec.articles];
  if (!spec.noForceMajeure) articles.push(FORCE_MAJEURE);
  articles.push(DISPUTE, NOTICES, ESIGN);

  const html = [
    `<h2 style="text-align:center">${spec.title}</h2>`,
    `<p>شماره‌ی قرارداد: <strong>[CONTRACT_NUMBER]</strong> &nbsp;&nbsp; تاریخ تنظیم: <strong>[DATE]</strong></p>`,
    `<h3>مقدمه و مشخصات طرفین</h3>`,
    partiesBlock(spec),
    `<p>${spec.preamble.replaceAll("{A}", spec.roles[0]).replaceAll("{B}", spec.roles[1])}</p>`,
    ...articles.map(([title, ...paras], i) => `<h3>ماده ${faNum(i + 1)} — ${title}</h3>${renderParagraphs(paras, spec.roles)}`),
  ].join("\n");

  const text = html.replace(/<[^>]*>/g, " ").replace(/\{\{[^}]*\}\}|\(\([^)]*\)\)|\[[A-Z_]+\]/g, " ");
  return {
    key: spec.key,
    category: spec.category,
    title: spec.title,
    summary: spec.summary,
    tags: spec.tags,
    roles: spec.roles,
    extraSigners: spec.extraSigners ?? [],
    legalBasis: spec.legalBasis,
    body: html,
    articleCount: articles.length,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

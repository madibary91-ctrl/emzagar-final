import { type LandingDoc, type Props, type Section, type SectionType } from "./model";
import { SECTION_DEFS } from "./defs";
import { sanitizeProps } from "./sanitize";

/* ───────── محتوای پیش‌فرض ───────── */
export const SECTION_STARTERS: Record<SectionType, Props> = {
  hero: { variant: "split", tone: "brand", badge: "عنوان کوتاه", title: "تیتر جذاب شما", titleAccent: "با ادامه‌ی رنگی", subtitle: "یک یا دو جمله برای توضیح اینکه محصول شما چه مشکلی را حل می‌کند.", primaryLabel: "شروع کنید", primaryHref: "/register", secondaryLabel: "امکانات", secondaryHref: "#features", showMock: true },
  logos: { heading: "مورد اعتماد", items: [{ label: "نام اول", image: "" }, { label: "نام دوم", image: "" }, { label: "نام سوم", image: "" }] },
  stats: { items: [{ value: "۱۰۰٪", label: "توضیح عدد اول" }, { value: "۲۴/۷", label: "توضیح عدد دوم" }, { value: "۵ دقیقه", label: "توضیح عدد سوم" }] },
  features: { eyebrow: "امکانات", heading: "چرا ما؟", subheading: "دلایل اصلی انتخاب محصول شما", columns: "3", style: "cards", items: [{ icon: "check", title: "امکان اول", text: "توضیح کوتاه درباره‌ی این امکان." }, { icon: "zap", title: "امکان دوم", text: "توضیح کوتاه درباره‌ی این امکان." }, { icon: "shield", title: "امکان سوم", text: "توضیح کوتاه درباره‌ی این امکان." }] },
  steps: { eyebrow: "چطور کار می‌کند", heading: "در چند گام ساده", subheading: "", items: [{ title: "گام اول", text: "توضیح" }, { title: "گام دوم", text: "توضیح" }, { title: "گام سوم", text: "توضیح" }] },
  showcase: { eyebrow: "", heading: "", items: [{ icon: "sparkles", title: "عنوان ردیف", text: "توضیح کوتاه درباره‌ی این ردیف.", bullets: "نکته‌ی اول\nنکته‌ی دوم", image: "", ctaLabel: "", ctaHref: "" }] },
  testimonials: { eyebrow: "نظر مشتریان", heading: "مشتریان چه می‌گویند", items: [{ quote: "متن نظر مشتری را اینجا بنویسید.", name: "نام مشتری", role: "سمت یا کسب‌وکار", avatar: "" }] },
  pricing: { eyebrow: "قیمت‌گذاری", heading: "طرح مناسب خودتان را انتخاب کنید", subheading: "طرح‌ها و قیمت‌ها از تنظیمات اشتراک خوانده می‌شوند.", ctaLabel: "مقایسه‌ی کامل طرح‌ها", footnote: "" },
  faq: { eyebrow: "پرسش‌ها", heading: "پرسش‌های متداول", items: [{ q: "پرسش اول؟", a: "پاسخ پرسش اول." }, { q: "پرسش دوم؟", a: "پاسخ پرسش دوم." }] },
  cta: { tone: "brand", heading: "آماده‌اید شروع کنیم؟", text: "همین حالا ثبت‌نام کنید.", primaryLabel: "ثبت‌نام", primaryHref: "/register", secondaryLabel: "", secondaryHref: "" },
  text: { eyebrow: "", heading: "عنوان", body: "متن خود را اینجا بنویسید.", align: "right" },
};
function sec(id: string, type: SectionType, props: Props, enabled = true): Section {
  return { id, type, enabled, props: sanitizeProps(SECTION_DEFS[type].fields, props) };
}
export function defaultDoc(siteName = "امضاگیر"): LandingDoc {
  const sections: Section[] = [
    sec("hero", "hero", {
      variant: "split", tone: "brand", badge: "امضای دیجیتال با تأیید هویت پیامکی",
      title: "قرارداد را آنلاین امضا کنید،", titleAccent: "بدون کاغذ و بدون دردسر.",
      subtitle: `با ${siteName} قرارداد را بسازید، برای مشتری بفرستید و در چند دقیقه امضای معتبر همراه با شناسنامه‌ی دیجیتال دریافت کنید.`,
      primaryLabel: "ساخت حساب رایگان", primaryHref: "/register", secondaryLabel: "دیدن امکانات", secondaryHref: "#features",
      note: "بدون نیاز به کارت بانکی · راه‌اندازی در چند دقیقه", showMock: true,
    }),
    sec("trust", "logos", {
      heading: "مناسب کسب‌وکارهایی که قرارداد زیاد می‌بندند",
      items: [{ label: "آژانس‌های دیجیتال" }, { label: "فروشگاه‌های اینترنتی" }, { label: "املاک و مستغلات" }, { label: "آموزشگاه‌ها" }, { label: "شرکت‌های خدماتی" }],
    }),
    sec("stats", "stats", {
      items: [{ value: "۵ دقیقه", label: "از ثبت‌نام تا اولین قرارداد" }, { value: "OTP", label: "تأیید هویت پیامکی پیش از امضا" }, { value: "SHA-256", label: "اثر انگشت یکتا برای هر سند" }, { value: "۲۴/۷", label: "دسترسی از هر دستگاه" }],
    }),
    sec("features", "features", {
      eyebrow: "امکانات", heading: "همه‌چیز برای امضای مطمئن", subheading: "از ساخت قالب تا بایگانی؛ بدون هیچ دانش فنی.", columns: "3", style: "cards",
      items: [
        { icon: "fingerprint", title: "تأیید هویت با کد پیامکی", text: "هر امضاکننده پیش از امضا با کد یک‌بارمصرف تأیید می‌شود؛ کد منقضی می‌شود و تعداد تلاش محدود است." },
        { icon: "pen", title: "امضای دست‌نویس یا تصویر", text: "امضا با انگشت یا ماوس روی بوم ترسیم می‌شود یا تصویر امضا بارگذاری می‌گردد." },
        { icon: "file", title: "قالب و متغیرهای هوشمند", text: "قالب‌های آماده بسازید و نام، مبلغ و تاریخ را به‌صورت خودکار جایگذاری کنید." },
        { icon: "users", title: "چند امضاکننده با ترتیب", text: "مالی، فروش و مشتری هر کدام نوبت خود را دارند و نفر بعدی خودکار فعال می‌شود." },
        { icon: "shield", title: "شناسنامه‌ی دیجیتال", text: "زمان، IP و اثر انگشت سند ثبت می‌شود تا هر قرارداد قابل راستی‌آزمایی باشد." },
        { icon: "sparkles", title: "هوش مصنوعی و تحلیل ریسک", text: "پیش‌نویس قرارداد را با هوش مصنوعی بنویسید و بندهای پرخطر را پیش از ارسال ببینید." },
      ],
    }),
    sec("how", "steps", {
      eyebrow: "چطور کار می‌کند", heading: "چهار گام تا قرارداد امضاشده", subheading: "",
      items: [
        { title: "قالب را انتخاب کنید", text: "از قالب‌های آماده استفاده کنید یا متن خودتان را بنویسید." },
        { title: "برای طرف مقابل بفرستید", text: "لینک امن قرارداد با پیامک یا ایمیل ارسال می‌شود." },
        { title: "تأیید هویت و امضا", text: "طرف مقابل با کد پیامکی وارد می‌شود و امضا می‌کند." },
        { title: "بایگانی و پیگیری", text: "نسخه‌ی نهایی با شناسنامه‌ی دیجیتال در پنل شما می‌ماند." },
      ],
    }),
    sec("wordpress", "showcase", {
      eyebrow: "اتصال به سایت شما", heading: "کنار ابزارهایی که از قبل دارید",
      items: [
        { icon: "plug", title: "افزونه‌ی وردپرس و ووکامرس", text: "با یک افزونه، امضای قرارداد را به فرایند خرید فروشگاه‌تان اضافه کنید.", bullets: "نصب و اتصال یک‌کلیکی\nسازگار با المنتور\nورود مستقیم به پنل از وردپرس", image: "", ctaLabel: "", ctaHref: "" },
        { icon: "wand", title: "API و وب‌هوک", text: "قرارداد را از هر نرم‌افزاری صادر کنید و وضعیت امضا را لحظه‌ای دریافت کنید.", bullets: "کلید API اختصاصی\nاعلان در تلگرام و بله\nمستندات کامل", image: "", ctaLabel: "", ctaHref: "" },
      ],
    }),
    sec("reviews", "testimonials", {
      eyebrow: "نظر مشتریان", heading: "مشتریان ما چه می‌گویند",
      items: [{ quote: "این نمونه‌متن است؛ نظر واقعی مشتری‌تان را اینجا بنویسید و بخش را روشن کنید.", name: "نام مشتری", role: "مدیر یک کسب‌وکار", avatar: "" }],
    }, false),
    sec("pricing", "pricing", {
      eyebrow: "قیمت‌گذاری", heading: "طرحی متناسب با اندازه‌ی کسب‌وکار شما", subheading: "با طرح رایگان شروع کنید و هر زمان خواستید ارتقا دهید.",
      ctaLabel: "مقایسه‌ی کامل طرح‌ها", footnote: "قیمت‌ها به تومان و ماهانه است.",
    }),
    sec("faq", "faq", {
      eyebrow: "پرسش‌ها", heading: "پرسش‌های متداول",
      items: [
        { q: "امضای آنلاین از نظر قانونی معتبر است؟", a: "هر امضا همراه با تأیید هویت پیامکی، زمان، IP و اثر انگشت سند ثبت می‌شود که ادله‌ی مهمی برای اثبات است. برای قراردادهای خاص با مشاور حقوقی خود هم مشورت کنید." },
        { q: "طرف مقابل باید حساب کاربری بسازد؟", a: "خیر. او فقط لینک قرارداد را باز می‌کند، با کد پیامکی تأیید می‌شود و امضا می‌کند." },
        { q: "می‌توانم قالب قرارداد خودم را بسازم؟", a: "بله. ویرایشگر قالب دارید و با متغیرهایی مثل نام و مبلغ، هر قرارداد را خودکار پر می‌کنید." },
        { q: "آیا با وردپرس و ووکامرس کار می‌کند؟", a: "بله. افزونه‌ی اختصاصی داریم که با چند کلیک نصب و متصل می‌شود." },
        { q: "اطلاعات و امضاها کجا نگهداری می‌شود؟", a: "امضاها خارج از دسترس عمومی نگهداری می‌شوند و فقط افراد مجاز به آن‌ها دسترسی دارند." },
      ],
    }),
    sec("start", "cta", {
      tone: "brand", heading: "اولین قرارداد را همین امروز امضا کنید", text: "ثبت‌نام رایگان است و کمتر از ۵ دقیقه طول می‌کشد.",
      primaryLabel: "ساخت حساب رایگان", primaryHref: "/register", secondaryLabel: "ورود به حساب", secondaryHref: "/login",
    }),
  ];
  return {
    v: 1,
    theme: { brandName: siteName, logo: "", primary: "#102c31", accent: "#41e4ad", mode: "light", radius: "round" },
    seo: { title: `${siteName} — امضای آنلاین قرارداد`, description: "ساخت، ارسال و امضای آنلاین قرارداد با تأیید هویت پیامکی و شناسنامه‌ی دیجیتال. مناسب فروشگاه‌ها، آژانس‌ها و کسب‌وکارهای ایرانی.", image: "" },
    announcement: { enabled: false, text: "🎉 طرح حرفه‌ای را امتحان کنید", link: "/pricing" },
    nav: {
      links: [{ label: "امکانات", href: "#features" }, { label: "مراحل", href: "#how" }, { label: "قیمت‌ها", href: "#pricing" }, { label: "پرسش‌ها", href: "#faq" }],
      ctaLabel: "ورود", ctaHref: "/login",
    },
    footer: {
      about: "پلتفرم امضای آنلاین قرارداد با تأیید هویت پیامکی، شناسنامه‌ی دیجیتال و اتصال به وردپرس.",
      columns: [
        { title: "محصول", links: [{ label: "امکانات", href: "#features" }, { label: "قیمت‌ها", href: "/pricing" }, { label: "استعلام اصالت سند", href: "/verify" }] },
        { title: "حساب کاربری", links: [{ label: "ورود", href: "/login" }, { label: "ثبت‌نام", href: "/register" }, { label: "پشتیبانی", href: "/support" }] },
      ],
      copyright: `© ${siteName} — همه‌ی حقوق محفوظ است.`,
    },
    sections,
  };
}
/** هر بخش چه آدرس‌هایی (لنگر) برای لینک‌دهی داخلی دارد */
export function anchorOptions(doc: LandingDoc): { value: string; label: string }[] {
  return doc.sections.map((s) => ({ value: `#${s.id}`, label: `بخش «${SECTION_DEFS[s.type].label}»` }));
}
export const PAGE_LINKS: { value: string; label: string }[] = [
  { value: "/login", label: "صفحه‌ی ورود" },
  { value: "/register", label: "صفحه‌ی ثبت‌نام" },
  { value: "/pricing", label: "صفحه‌ی قیمت‌ها" },
  { value: "/verify", label: "استعلام اصالت سند" },
  { value: "/support", label: "پشتیبانی" },
];

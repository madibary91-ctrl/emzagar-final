/** داده‌های ثابت و واقع‌گرایانه‌ی نمونه (فارسی). هیچ منطق دیتابیسی اینجا نیست. */

export const DEMO_EMAIL_DOMAIN = "demo.emzagar.invalid";

export interface DemoPerson {
  name: string;
  mobile: string;
  company: string;
}

export const DEMO_PEOPLE: DemoPerson[] = [
  { name: "علی رضایی", mobile: "09121110001", company: "گروه صنعتی آریا" },
  { name: "سارا احمدی", mobile: "09121110002", company: "استودیو طراحی نقش" },
  { name: "محمد کریمی", mobile: "09121110003", company: "فروشگاه آنلاین بازارچه" },
  { name: "نگار حسینی", mobile: "09121110004", company: "کلینیک زیبایی مهر" },
  { name: "رضا موسوی", mobile: "09121110005", company: "ساختمان‌سازی پایا" },
  { name: "مریم صادقی", mobile: "09121110006", company: "آموزشگاه زبان پارس" },
  { name: "امیر نوری", mobile: "09121110007", company: "تجارت الکترونیک دیجی‌نو" },
  { name: "الهام باقری", mobile: "09121110008", company: "مشاوره مالیاتی تراز" },
];

const wrap = (title: string, intro: string, articles: [string, string][]) =>
  `<h2 style="text-align:center">${title}</h2>
<p>شماره قرارداد: <strong>[CONTRACT_NUMBER]</strong> &nbsp;&nbsp; تاریخ: <strong>[DATE]</strong></p>
<p>${intro}</p>
${articles.map(([h, t], i) => `<h3>ماده ${["۱", "۲", "۳", "۴", "۵", "۶"][i]} — ${h}</h3>\n<p>${t}</p>`).join("\n")}`;

export const DEMO_BODIES = {
  web: wrap(
    "قرارداد طراحی و راه‌اندازی وب‌سایت",
    "این قرارداد میان <strong>[SITE_NAME]</strong> (به‌عنوان «مجری») و <strong>[USER_NAME]</strong> با ایمیل [USER_EMAIL] و موبایل [USER_MOBILE] (به‌عنوان «کارفرما») منعقد می‌شود.",
    [
      ["موضوع", "طراحی، پیاده‌سازی و راه‌اندازی وب‌سایت «[PRODUCT_NAME]» مطابق سند نیازمندی‌های پیوست."],
      ["مبلغ و نحوه پرداخت", "مبلغ کل قرارداد [AMOUNT] تومان است؛ ۴۰٪ هنگام امضا، ۴۰٪ پس از تحویل نسخه‌ی آزمایشی و ۲۰٪ پس از تحویل نهایی پرداخت می‌شود."],
      ["مدت اجرا", "مدت اجرای پروژه ۶۰ روز کاری از تاریخ پرداخت پیش‌پرداخت است."],
      ["محرمانگی", "طرفین متعهدند اطلاعات تجاری یکدیگر را محرمانه نگه دارند و بدون رضایت کتبی افشا نکنند."],
      ["فسخ و حل اختلاف", "در صورت اختلاف، ابتدا از راه مذاکره و سپس از طریق داوری یا مراجع قضایی تهران اقدام می‌شود."],
    ],
  ),
  nda: wrap(
    "تعهدنامه‌ی محرمانگی (NDA)",
    "اینجانب <strong>[USER_NAME]</strong> متعهد می‌شوم اطلاعات فنی، مالی و تجاری [SITE_NAME] را که در جریان همکاری به آن‌ها دسترسی پیدا می‌کنم، محرمانه نگه دارم.",
    [
      ["تعریف اطلاعات محرمانه", "هر سند، کد، قیمت، فهرست مشتریان و برنامه‌ی تجاری که به‌صورت شفاهی یا کتبی منتقل شود."],
      ["مدت تعهد", "این تعهد تا دو سال پس از پایان همکاری معتبر است."],
      ["ضمانت اجرا", "نقض این تعهد موجب مسئولیت مدنی و جبران کلیه‌ی خسارات وارده خواهد بود."],
    ],
  ),
  lease: wrap(
    "قرارداد اجاره‌ی دفتر کار",
    "این قرارداد میان <strong>[SITE_NAME]</strong> (موجر) و <strong>[USER_NAME]</strong> (مستأجر) با موبایل [USER_MOBILE] منعقد می‌گردد.",
    [
      ["موضوع", "اجاره‌ی یک واحد اداری به متراژ ۷۵ متر مربع برای استفاده‌ی اداری."],
      ["مدت و اجاره‌بها", "مدت اجاره یک سال شمسی و اجاره‌بهای ماهانه [AMOUNT] تومان است که تا پنجم هر ماه پرداخت می‌شود."],
      ["تعهدات مستأجر", "نگهداری از واحد، پرداخت قبوض مصرفی و عدم واگذاری به غیر بدون اجازه‌ی کتبی موجر."],
      ["تخلیه", "مستأجر موظف است پایان مدت اجاره، واحد را به همان وضعیت تحویل‌گرفته‌شده تحویل دهد."],
    ],
  ),
  marketing: wrap(
    "قرارداد خدمات دیجیتال مارکتینگ",
    "این قرارداد میان <strong>[SITE_NAME]</strong> (ارائه‌دهنده) و <strong>[USER_NAME]</strong> (مشتری) برای ارائه‌ی خدمات «[PRODUCT_NAME]» منعقد می‌شود.",
    [
      ["موضوع", "مدیریت شبکه‌های اجتماعی، تولید محتوا و گزارش‌دهی ماهانه‌ی عملکرد."],
      ["مبلغ", "حق‌الزحمه‌ی ماهانه [AMOUNT] تومان است و در ابتدای هر ماه پرداخت می‌شود."],
      ["گزارش‌دهی", "ارائه‌دهنده موظف است تا روز پنجم هر ماه گزارش عملکرد ماه قبل را ارسال کند."],
      ["فسخ", "هر یک از طرفین با ۳۰ روز اطلاع‌رسانی کتبی می‌تواند قرارداد را فسخ کند."],
    ],
  ),
  employment: wrap(
    "قرارداد همکاری پاره‌وقت",
    "این قرارداد میان <strong>[SITE_NAME]</strong> (کارفرما) و <strong>[USER_NAME]</strong> (همکار) با ایمیل [USER_EMAIL] منعقد می‌شود.",
    [
      ["موضوع", "همکاری پاره‌وقت در حوزه‌ی پشتیبانی مشتریان به‌صورت دورکاری."],
      ["حقوق", "حقوق ماهانه [AMOUNT] تومان و در پایان هر ماه پرداخت می‌شود."],
      ["محرمانگی", "همکار متعهد به حفظ اطلاعات مشتریان و کسب‌وکار کارفرما است."],
    ],
  ),
} as const;

export type DemoBodyKey = keyof typeof DEMO_BODIES;

export interface DemoContractPlan {
  title: string;
  body: DemoBodyKey;
  person: number;
  status: "signed" | "sent" | "draft" | "rejected" | "expired" | "cancelled";
  /** چند روز پیش صادر شده */
  daysAgo: number;
  /** چند ساعت پس از صدور امضا شده (فقط signed) */
  signAfterHours?: number;
  amount: number;
  product?: string;
  /** قرارداد دو امضایی: ابتدا نماینده‌ی کسب‌وکار، سپس مشتری */
  twoSigners?: boolean;
  /** مدت اعتبار (روز) برای قراردادهای امضاشده؛ پایان مدت برای صفحه‌ی تمدید */
  termDays?: number;
  termEndsInDays?: number;
  /** مشتری قرارداد را باز کرده اما هنوز امضا نکرده */
  viewed?: boolean;
  reminders?: number;
  rejectReason?: string;
}

export const DEMO_CONTRACTS: DemoContractPlan[] = [
  { title: "طراحی وب‌سایت شرکتی آریا", body: "web", person: 0, status: "signed", daysAgo: 52, signAfterHours: 5, amount: 48_000_000, product: "طراحی وب‌سایت شرکتی", twoSigners: true },
  { title: "تعهدنامه‌ی محرمانگی — پروژه‌ی نقش", body: "nda", person: 1, status: "signed", daysAgo: 41, signAfterHours: 2, amount: 0 },
  { title: "اجاره‌ی دفتر کار — طبقه‌ی سوم", body: "lease", person: 4, status: "signed", daysAgo: 38, signAfterHours: 26, amount: 36_000_000, twoSigners: true, termDays: 365, termEndsInDays: 21 },
  { title: "خدمات دیجیتال مارکتینگ بازارچه", body: "marketing", person: 2, status: "signed", daysAgo: 27, signAfterHours: 9, amount: 18_500_000, product: "مدیریت شبکه‌های اجتماعی", termDays: 180, termEndsInDays: 140 },
  { title: "همکاری پاره‌وقت پشتیبانی", body: "employment", person: 5, status: "signed", daysAgo: 19, signAfterHours: 30, amount: 12_000_000 },
  { title: "تعهدنامه‌ی محرمانگی — دیجی‌نو", body: "nda", person: 6, status: "signed", daysAgo: 9, signAfterHours: 3, amount: 0 },
  { title: "طراحی وب‌سایت کلینیک مهر", body: "web", person: 3, status: "signed", daysAgo: 4, signAfterHours: 7, amount: 62_000_000, product: "طراحی وب‌سایت شرکتی", twoSigners: true },
  { title: "خدمات مارکتینگ آموزشگاه پارس", body: "marketing", person: 5, status: "sent", daysAgo: 3, amount: 14_000_000, product: "کمپین تبلیغاتی", viewed: true, reminders: 1 },
  { title: "طراحی فروشگاه‌ساز دیجی‌نو", body: "web", person: 6, status: "sent", daysAgo: 2, amount: 75_000_000, product: "فروشگاه اینترنتی", twoSigners: true, viewed: true },
  { title: "قرارداد مشاوره‌ی مالیاتی تراز", body: "marketing", person: 7, status: "sent", daysAgo: 1, amount: 9_000_000, product: "مشاوره‌ی مالیاتی" },
  { title: "پیش‌نویس: توسعه‌ی اپلیکیشن موبایل", body: "web", person: 0, status: "draft", daysAgo: 1, amount: 120_000_000, product: "اپلیکیشن موبایل" },
  { title: "اجاره‌ی انبار — بازارچه", body: "lease", person: 2, status: "rejected", daysAgo: 22, amount: 28_000_000, viewed: true, rejectReason: "مبلغ اجاره‌بها بالاتر از توافق اولیه است." },
  { title: "تعهدنامه‌ی محرمانگی — تراز", body: "nda", person: 7, status: "expired", daysAgo: 47, amount: 0 },
  { title: "همکاری پاره‌وقت — طراح گرافیک", body: "employment", person: 1, status: "cancelled", daysAgo: 14, amount: 8_000_000 },
];

export interface DemoTicketPlan {
  person: number;
  subject: string;
  category: "general" | "technical" | "billing" | "ai" | "wordpress" | "feature";
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "in_progress" | "closed";
  daysAgo: number;
  body: string;
  replies: { staff: boolean; hoursLater: number; body: string; internal?: boolean }[];
  rating?: number;
}

export const DEMO_TICKETS: DemoTicketPlan[] = [
  {
    person: 0,
    subject: "کد پیامکی تایید دیر می‌رسد",
    category: "technical",
    priority: "high",
    status: "open",
    daysAgo: 1,
    body: "سلام، چند مشتری ما می‌گویند کد تایید امضا را با چند دقیقه تاخیر دریافت می‌کنند. لطفاً بررسی کنید.",
    replies: [],
  },
  {
    person: 3,
    subject: "راهنمای اتصال به وردپرس و ووکامرس",
    category: "wordpress",
    priority: "normal",
    status: "in_progress",
    daysAgo: 4,
    body: "افزونه را نصب کردم ولی مطمئن نیستم قرارداد بعد از پرداخت ووکامرس چطور ساخته می‌شود. راهنمایی می‌کنید؟",
    replies: [
      { staff: true, hoursLater: 3, body: "سلام و وقت بخیر. در تنظیمات افزونه گزینه‌ی «صدور خودکار پس از پرداخت» را فعال کنید؛ از آن لحظه با هر سفارش تکمیل‌شده یک قرارداد برای مشتری صادر می‌شود." },
      { staff: true, hoursLater: 3.5, body: "یادداشت داخلی: مشتری نسخه‌ی قدیمی افزونه دارد؛ پیشنهاد به‌روزرسانی داده شود.", internal: true },
      { staff: false, hoursLater: 20, body: "ممنون، فعال کردم. فقط هنوز لینک امضا ایمیل نشده؛ SMTP را باید تنظیم کنم؟" },
    ],
  },
  {
    person: 2,
    subject: "صورت‌حساب طرح حرفه‌ای",
    category: "billing",
    priority: "low",
    status: "closed",
    daysAgo: 12,
    body: "برای ارتقا به طرح حرفه‌ای فاکتور رسمی می‌خواهم. چگونه دریافت کنم؟",
    replies: [
      { staff: true, hoursLater: 2, body: "فاکتور رسمی از بخش «اشتراک و پرداخت ← تاریخچه‌ی پرداخت‌ها» قابل دریافت است. اگر مشخصات اقتصادی شرکت را بفرستید، فاکتور به نام شرکت صادر می‌شود." },
      { staff: false, hoursLater: 6, body: "عالی بود، دریافت کردم. سپاس." },
    ],
    rating: 5,
  },
  {
    person: 7,
    subject: "پیشنهاد: امضای گروهی برای چند قرارداد",
    category: "feature",
    priority: "low",
    status: "open",
    daysAgo: 6,
    body: "خوب است اگر بتوانیم یک لینک بسازیم که مشتری با یک کد پیامکی چند قرارداد را با هم امضا کند.",
    replies: [{ staff: true, hoursLater: 30, body: "ممنون از پیشنهاد! در فهرست توسعه ثبت شد و در نسخه‌های بعدی بررسی می‌شود." }],
  },
];

export const DEMO_PRODUCTS = [
  { title: "طراحی وب‌سایت شرکتی", description: "طراحی و راه‌اندازی وب‌سایت با پشتیبانی سه‌ماهه", price: 48_000_000 },
  { title: "مدیریت شبکه‌های اجتماعی", description: "تولید محتوا و گزارش ماهانه‌ی عملکرد", price: 18_500_000 },
  { title: "مشاوره‌ی مالیاتی", description: "بررسی اظهارنامه و برنامه‌ریزی مالیاتی", price: 9_000_000 },
];

/**
 * انواع مشترک «داشبورد سلامت سیستم».
 * هر بررسی (Check) یک CheckResult می‌سازد؛ رابط کاربری و API فقط با همین ساختار کار می‌کنند.
 */
export type HealthStatus = "ok" | "warn" | "fail" | "unconfigured";

export type GroupId = "core" | "comms" | "payments" | "ai" | "license" | "business";

export const GROUPS: { id: GroupId; label: string; blurb: string }[] = [
  { id: "core", label: "زیرساخت و امنیت", blurb: "دیتابیس، سرور، ذخیره‌سازی، زمان‌بند و بک‌آپ" },
  { id: "comms", label: "ایمیل و پیامک", blurb: "ارسال کد امضا، لینک‌ها و اعلان‌ها" },
  { id: "payments", label: "پرداخت و کیف پول", blurb: "درگاه‌ها، تراکنش‌ها و یکپارچگی دفتر کل" },
  { id: "ai", label: "هوش مصنوعی", blurb: "اتصال به سرویس تولید و تحلیل متن" },
  { id: "license", label: "لایسنس و به‌روزرسانی", blurb: "سرور لایسنس و کانال انتشار نسخه" },
  { id: "business", label: "احراز هویت، دعوت و همگام‌سازی", blurb: "KYC، سیستم دعوت دوستان و صف همگام‌سازی" },
];

/** یک مرحله از عیب‌یابی (مثلاً DNS ← TCP ← TLS ← HTTP) */
export interface Step {
  name: string;
  ok: boolean;
  ms?: number;
  detail?: string;
}

export interface Metric {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "fail";
}

export interface CheckResult {
  id: string;
  group: GroupId;
  label: string;
  status: HealthStatus;
  summary: string;
  latencyMs: number | null;
  checkedAt: string;
  /** این نتیجه از «تست عمیق» (با اعتبارسنجی کامل یا اثر جانبی کم) آمده است */
  deep: boolean;
  /** نتیجه از حافظه‌ی نهان (چند ثانیه‌ی اخیر) آمده است */
  cached?: boolean;
  /** منبع پیکربندی مؤثر (فضای کاری / پلتفرم / محیط) */
  source?: string;
  metrics: Metric[];
  steps: Step[];
  hints: string[];
  /** وزن در امتیاز آمادگی لانچ (۰ = اطلاعاتی) */
  weight: number;
  /** اگر fail/unconfigured باشد مانع لانچ است */
  blocker: boolean;
  deepAvailable: boolean;
  deepLabel?: string;
  /** آخرین نتیجه‌ی تست عمیق (در حافظه‌ی سرور نگه‌داری می‌شود) */
  lastDeep?: { at: string; status: HealthStatus; summary: string; latencyMs: number | null };
  /** پیوند به صفحه‌ی رفع مشکل */
  fixHref?: string;
  fixLabel?: string;
}

/** خروجی داخلی هر بررسی (بقیه‌ی فیلدها را اجراکننده پر می‌کند) */
export interface CheckOutput {
  status: HealthStatus;
  summary: string;
  latencyMs?: number | null;
  source?: string;
  metrics?: Metric[];
  steps?: Step[];
  hints?: string[];
}

export interface CheckContext {
  workspaceId: number;
  /** آدرس پایه‌ی عمومی سایت (برای callback درگاه‌ها) */
  origin: string;
}

export interface CheckDef {
  id: string;
  group: GroupId;
  label: string;
  weight: number;
  deepAvailable?: boolean;
  deepLabel?: string;
  fixHref?: string;
  fixLabel?: string;
  run(ctx: CheckContext, deep: boolean): Promise<CheckOutput>;
}

export interface HistoryInfo {
  uptime24h: number | null;
  uptime7d: number | null;
  samples: { t: string; s: HealthStatus; ms: number | null }[];
}

export interface IncidentView {
  id: number;
  checkId: string;
  label: string;
  severity: string;
  message: string;
  startedAt: string;
  resolvedAt: string | null;
}

export interface Readiness {
  score: number;
  verdict: "ready" | "almost" | "not_ready";
  verdictLabel: string;
  blockers: { id: string; label: string; status: HealthStatus; summary: string; fixHref?: string }[];
  counts: Record<HealthStatus, number>;
}

export interface EnvAuditItem {
  name: string;
  set: boolean;
  level: "required" | "recommended" | "optional" | "danger";
  note: string;
  /** برای پرچم‌های خطرناک: مقدار فعلی روشن است؟ */
  risky?: boolean;
}

export interface HealthSnapshot {
  generatedAt: string;
  environment: { nodeEnv: string; simulator: string | null; version: string; nodeVersion: string; workspaceId: number; workspaceName: string; uptimeSec: number };
  results: CheckResult[];
  history: Record<string, HistoryInfo>;
  incidents: IncidentView[];
  readiness: Readiness;
  envAudit: EnvAuditItem[];
}

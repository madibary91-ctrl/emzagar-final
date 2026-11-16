/**
 * اعتبارسنجی «نام مدل» در برابر فهرست زنده‌ی سرویس (خالص؛ در کلاینت و سرور قابل‌استفاده).
 * پیش‌تر «تست اتصال» فقط کلید را می‌سنجید؛ مدل اشتباه تا اولین تولید قرارداد (و سوختن یک سهمیه) پنهان می‌ماند.
 */
const norm = (m: string) => m.trim().replace(/^models\//, "").toLowerCase();

/** نزدیک‌ترین مدل‌های فهرست به نام واردشده (پیشوند/شمول)، حداکثر ۳ مورد */
export function suggestModels(models: string[], model: string): string[] {
  const q = norm(model);
  if (!q) return [];
  const starts = models.filter((m) => norm(m).startsWith(q) || q.startsWith(norm(m)));
  const has = models.filter((m) => !starts.includes(m) && (norm(m).includes(q) || q.includes(norm(m))));
  return [...starts, ...has].slice(0, 3);
}

/** اگر فهرست سرویس مدل واردشده را ندارد، هشدار فارسی با پیشنهاد؛ وگرنه رشته‌ی خالی. فهرست خالی = قابل‌قضاوت‌نیست. */
export function modelWarning(models: string[], model: string): string {
  const m = (model || "").trim();
  if (!m || models.length === 0) return "";
  if (models.some((x) => norm(x) === norm(m))) return "";
  const near = suggestModels(models, m);
  return `مدل «${m}» در فهرست این سرویس نیست؛ در تولید قرارداد خطا می‌دهد.${near.length ? ` شاید منظورتان این بود: ${near.join("، ")}` : " یکی از مدل‌های فهرست را انتخاب کنید."}`;
}

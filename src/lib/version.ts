/** نسخه‌ی محصول. با هر انتشار این مقدار را بالا ببرید (به‌روزرسانی خودکار خریداران بر اساس آن کار می‌کند). */
export const APP_VERSION = "2.1.0";
export const PRODUCT_ID = "emzagar";

/** مقایسه‌ی نسخه‌ی معنایی ساده (1.2.3 یا 1.2.3-beta.1)؛ عدد مثبت یعنی a جدیدتر است */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ""] = v.trim().replace(/^v/i, "").split("-");
    return { nums: core.split(".").map((x) => parseInt(x, 10) || 0), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length, 3); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // نسخه‌ی پایدار از پیش‌انتشار جدیدتر است
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export const isValidVersion = (v: string) => /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,20})?$/.test(v);

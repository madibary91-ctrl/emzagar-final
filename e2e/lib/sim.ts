/**
 * دسترسی ربات مرورگری به «شبیه‌ساز سرویس‌های بیرونی».
 * اجراکننده‌ی scripts/e2e.ts شبیه‌ساز را بالا می‌آورد و E2E_SIM_URL را می‌دهد؛
 * برای اجرای دستی: npx tsx simulator/cli.ts --port 4110 --startpay auto  و  E2E_SIM_URL=http://127.0.0.1:4110
 */
import { SimClient } from "../../simulator/src/client";

export const SIM_URL = process.env.E2E_SIM_URL;
export const sim: SimClient | null = SIM_URL ? new SimClient(SIM_URL) : null;

/** نسخه‌ی غیر-null برای داخل آزمون‌هایی که با test.skip(!sim) محافظت شده‌اند */
export function needSim(): SimClient {
  if (!sim) throw new Error("E2E_SIM_URL تنظیم نشده است (آزمون‌های شبیه‌ساز فقط با scripts/e2e.ts یا شبیه‌ساز دستی اجرا می‌شوند)");
  return sim;
}

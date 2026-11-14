import { rateLimit } from "@/lib/rate-limit";
import { clientIp, errJson, failJson, okJson } from "@/modules/connect/http";
import { startHandshake } from "@/modules/connect/service";

export const dynamic = "force-dynamic";

/** مرحله‌ی ۱ اتصال خودکار (عمومی): بدون کلید؛ با محدودیت نرخ و تایید مالکیت دامنه در مرحله‌ی بعد */
export async function POST(req: Request) {
  const rl = rateLimit(`connect:reg:${clientIp(req)}`, 12, 60 * 60_000);
  if (!rl.ok) return errJson(429, "rate_limited", { retryAfter: rl.retryAfter });
  const body = await req.json().catch(() => null);
  try {
    const r = await startHandshake(body);
    return okJson(r);
  } catch (e) {
    return failJson(e);
  }
}

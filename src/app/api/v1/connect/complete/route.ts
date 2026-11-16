import { rateLimit } from "@/lib/rate-limit";
import { clientIp, cloudOrigin, errJson, failJson, okJson } from "@/modules/connect/http";
import { completeHandshake } from "@/modules/connect/service";

export const dynamic = "force-dynamic";

/** مرحله‌ی ۲ (عمومی): ابر سایت را تایید می‌کند، فضای کاری و کلید می‌سازد و کلید را یک‌بار برمی‌گرداند */
export async function POST(req: Request) {
  const rl = rateLimit(`connect:done:${clientIp(req)}`, 30, 60 * 60_000);
  if (!rl.ok) return errJson(429, "rate_limited", { retryAfter: rl.retryAfter });
  const body = (await req.json().catch(() => null)) as { handshakeId?: unknown } | null;
  try {
    const r = await completeHandshake(String(body?.handshakeId || ""));
    return okJson({ ...r, panelUrl: cloudOrigin(req) }, 201);
  } catch (e) {
    return failJson(e);
  }
}

import { NextResponse } from "next/server";
import { clientIpFrom } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { LICENSE_KEY_RE } from "@/modules/license/crypto";
import { deactivateDomain, evaluateLicense, licenseServerEnabled, signedVerdict } from "@/modules/license/server";

export const dynamic = "force-dynamic";
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "Cache-Control": "no-store" } });

/**
 * سرور لایسنس: فعال‌سازی/بررسی/آزادسازی دامنه. پاسخ با Ed25519 امضا می‌شود.
 * POST { key, domain, instanceId, version, nonce, action?: "check" | "deactivate" }
 */
export async function POST(req: Request) {
  if (!licenseServerEnabled()) return json({ ok: false, error: "not_found" }, 404);
  const ip = clientIpFrom((n) => req.headers.get(n));
  const rl = rateLimit(`lic:${ip}`, 60, 60_000);
  if (!rl.ok) return json({ ok: false, error: "rate_limited", retryAfter: rl.retryAfter }, 429);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ ok: false, error: "bad_request" }, 400);
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const key = str(body.key, 60).toUpperCase();
  const domain = str(body.domain, 253);
  const nonce = str(body.nonce, 80);
  if (!domain || !nonce) return json({ ok: false, error: "bad_request" }, 400);
  // سقف تلاش به‌ازای هر کلید (جلوگیری از حدس‌زدن)
  if (!rateLimit(`lic-key:${key || ip}`, 30, 60_000).ok) return json({ ok: false, error: "rate_limited" }, 429);

  if (body.action === "deactivate" && LICENSE_KEY_RE.test(key)) {
    await deactivateDomain(key, domain);
    return json({ ok: true });
  }
  const verdict = await evaluateLicense({
    key: LICENSE_KEY_RE.test(key) ? key : "invalid",
    domain,
    instanceId: str(body.instanceId, 64),
    version: str(body.version, 20),
    ip,
    touch: true,
  });
  return json({ ok: true, ...(await signedVerdict(verdict, nonce)) });
}

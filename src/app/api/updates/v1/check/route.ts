import { NextResponse } from "next/server";
import { clientIpFrom } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { PRODUCT_ID } from "@/lib/version";
import { LICENSE_KEY_RE, signPayload } from "@/modules/license/crypto";
import { evaluateLicense, getServerKeys, latestReleaseFor, licenseServerEnabled, signedVerdict } from "@/modules/license/server";

export const dynamic = "force-dynamic";
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "Cache-Control": "no-store" } });

/** POST { key, domain, version, channel, nonce } ← پاسخ امضاشده: آیا نسخه‌ی جدیدتری برای این لایسنس هست؟ */
export async function POST(req: Request) {
  if (!licenseServerEnabled()) return json({ ok: false, error: "not_found" }, 404);
  const ip = clientIpFrom((n) => req.headers.get(n));
  if (!rateLimit(`upd:${ip}`, 60, 60_000).ok) return json({ ok: false, error: "rate_limited" }, 429);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const key = str(body?.key, 60).toUpperCase();
  const domain = str(body?.domain, 253);
  const nonce = str(body?.nonce, 80);
  const version = str(body?.version, 20) || "0.0.0";
  if (!domain || !nonce) return json({ ok: false, error: "bad_request" }, 400);

  const verdict = await evaluateLicense({ key: LICENSE_KEY_RE.test(key) ? key : "invalid", domain, instanceId: "", version, ip, touch: false });
  if (!verdict.valid) return json({ ok: true, ...(await signedVerdict(verdict, nonce)) });

  const { latest, updateAvailable } = await latestReleaseFor({
    currentVersion: version,
    channel: str(body?.channel, 10) === "beta" ? "beta" : "stable",
    updatesUntil: verdict.updatesUntil ? new Date(verdict.updatesUntil) : null,
  });
  const keys = await getServerKeys();
  const signed = signPayload(
    {
      product: PRODUCT_ID,
      kind: "update",
      valid: true,
      status: verdict.status,
      updateAvailable,
      latest: latest ? { version: latest.version, changelog: latest.changelog, publishedAt: latest.publishedAt.toISOString(), size: latest.size, sha256: latest.sha256, security: latest.security } : null,
      nonce,
      issuedAt: new Date().toISOString(),
    },
    keys.privateKey,
  );
  return json({ ok: true, ...signed });
}

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { getOrCreateSigningLink } from "@/modules/signing/links";
import { getVaultAccess } from "@/modules/vault/service";
import { readVaultSession } from "@/modules/vault/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * «ادامه‌ی امضا» از کیف: امضاکننده را به لینک اختصاصی همان سند می‌برد.
 * صفحه‌ی امضا همچنان OTP پیامکی تازه می‌خواهد؛ پس کیف هیچ مرحله‌ی امنیتی امضا را دور نمی‌زند.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ip = clientIpFrom((n) => req.headers.get(n));
  const to = (path: string) => NextResponse.redirect(new URL(path, req.url), { status: 303, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  const mobile = await readVaultSession();
  if (!mobile) return to("/vault");
  if (!rateLimit(`vaultsign:${mobile}`, 30, 15 * 60_000).ok || !rateLimit(`vaultsign:ip:${ip}`, 60, 15 * 60_000).ok) return to("/vault?e=rate");
  const access = await getVaultAccess(mobile, Number(id));
  if (!access || access.signer.status !== "pending") return to("/vault?e=nodoc");
  const link = await getOrCreateSigningLink(access.signer.id);
  if (!link) return to("/vault?e=closed");
  return to(`/sign/${link.token}`);
}

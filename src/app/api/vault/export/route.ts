import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { logAudit } from "@/modules/audit/service";
import { vaultFail } from "@/modules/vault/http";
import { readVaultSession } from "@/modules/vault/session";
import { vaultZip } from "@/modules/vault/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** دانلود همه‌ی اسناد نهایی‌شده‌ی کیف در یک فایل ZIP (به‌همراه فهرست هش‌ها) */
export async function GET(req: Request) {
  const ip = clientIpFrom((n) => req.headers.get(n));
  const mobile = await readVaultSession();
  if (!mobile) return vaultFail(req, "auth", 401, "unauthorized");
  if (!rateLimit(`vaultzip:${mobile}`, 12, 15 * 60_000).ok || !rateLimit(`vaultzip:ip:${ip}`, 24, 15 * 60_000).ok) return vaultFail(req, "rate", 429, "too_many_requests");
  try {
    const part = Number(new URL(req.url).searchParams.get("part")) || 1;
    const z = await vaultZip(mobile, part);
    await logAudit({ action: "vault.exported", detail: `${z.count} سند — بخش ${z.part}/${z.parts} (${mobile.slice(0, 4)}***${mobile.slice(-2)})` });
    return new NextResponse(new Uint8Array(z.buffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${z.parts > 1 ? `emzagar-vault-part${z.part}` : "emzagar-vault"}.zip"`,
        "Content-Length": String(z.buffer.length),
        "X-Vault-Part": `${z.part}/${z.parts}`,
        "X-Vault-Skipped": String(z.skipped),
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (e) {
    console.error("[vault:zip]", e);
    return vaultFail(req, "zip", 500, "export_failed");
  }
}

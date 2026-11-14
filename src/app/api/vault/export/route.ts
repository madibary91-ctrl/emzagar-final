import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { logAudit } from "@/modules/audit/service";
import { readVaultSession } from "@/modules/vault/session";
import { vaultZip } from "@/modules/vault/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** دانلود همه‌ی اسناد نهایی‌شده‌ی کیف در یک فایل ZIP (به‌همراه فهرست هش‌ها) */
export async function GET(req: Request) {
  const ip = clientIpFrom((n) => req.headers.get(n));
  const mobile = await readVaultSession();
  if (!mobile) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`vaultzip:${mobile}`, 4, 15 * 60_000).ok || !rateLimit(`vaultzip:ip:${ip}`, 10, 15 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  try {
    const z = await vaultZip(mobile);
    await logAudit({ action: "vault.exported", detail: `${z.count} سند (${mobile.slice(0, 4)}***${mobile.slice(-2)})` });
    return new NextResponse(new Uint8Array(z.buffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="emzagar-vault.zip"`,
        "Content-Length": String(z.buffer.length),
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (e) {
    console.error("[vault:zip]", e);
    return NextResponse.json({ error: "export_failed" }, { status: 500 });
  }
}

import fs from "node:fs";
import { buildPluginZip } from "@/lib/wp-plugin-zip";
import { PLUGIN_ROOT, PLUGIN_SLUG } from "@/lib/wp-release";
import { cloudOrigin } from "@/modules/connect/http";
import { createPairingToken } from "@/modules/connect/service";
import { getTeamForApi } from "@/modules/tenancy/context";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/modules/connect/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * دانلود افزونه‌ی «از پیش پیکربندی‌شده»:
 * آدرس ابر داخل افزونه نوشته می‌شود تا کاربر هیچ آدرسی وارد نکند.
 * اگر کاربر وارد پنل شده باشد (?pair=1)، یک کد جفت‌سازی یک‌بارمصرف هم داخل بسته قرار می‌گیرد
 * تا افزونه خودکار به همان فضای کاری موجود وصل شود.
 *
 * امنیت (CR-05): بسته شامل RELEASE.json + RELEASE.sig (امضای Ed25519 ناشر) است و افزونه‌ی نصب‌شده پیش از هر
 * به‌روزرسانی آن را با کلید پین‌شده‌ی خودش بررسی می‌کند؛ فایل emzagar-config.php فقط از قالب ثابت ساخته می‌شود.
 */
export async function GET(req: Request) {
  const rl = rateLimit(`wp:zip:${clientIp(req)}`, 30, 10 * 60_000);
  if (!rl.ok) return new Response("Too many requests", { status: 429 });
  const origin = cloudOrigin(req);
  if (!origin) return new Response("Cannot determine the cloud address. Set APP_URL.", { status: 500 });
  if (!fs.existsSync(PLUGIN_ROOT)) return new Response("Plugin files not found", { status: 404 });

  let pairing = "";
  if (new URL(req.url).searchParams.get("pair") === "1") {
    const team = await getTeamForApi("settings");
    if (team) pairing = await createPairingToken(team.workspaceId, team.id);
  }

  let zip: Uint8Array;
  try {
    zip = buildPluginZip(origin, pairing);
  } catch {
    return new Response("Cannot build the plugin package", { status: 500 });
  }
  return new Response(Buffer.from(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${PLUGIN_SLUG}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}

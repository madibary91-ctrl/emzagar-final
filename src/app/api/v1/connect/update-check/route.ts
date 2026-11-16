import { authenticateApi } from "@/modules/api/service";
import { cloudOrigin, errJson, okJson } from "@/modules/connect/http";
import { getLicenseInfo } from "@/modules/license/client";
import { readPluginMeta } from "@/lib/wp-plugin";
import { verifyBundledRelease } from "@/lib/wp-release";
import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

/**
 * به‌روزرسانی خودکار افزونه‌ی وردپرس (Turnkey): افزونه با کلید API این مسیر را صدا می‌زند و می‌گیرد:
 *   - نسخه‌ی افزونه‌ی همراه همین ابر + آدرس بسته (همان /api/wordpress/plugin) + تغییرات
 *   - وضعیت لایسنس ابر (بدون هیچ کلید یا راز؛ فقط برای نمایش در پیشخوان وردپرس)
 * اگر LICENSE_REQUIRED=1 و لایسنس معتبر نباشد، بسته‌ی جدید عرضه نمی‌شود (افزونه‌ی نصب‌شده همچنان کار می‌کند).
 */
export async function GET(req: Request) {
  const auth = await authenticateApi(req, { bucket: "wp-update", limit: 30 });
  if (!auth.ok) return errJson(auth.status, auth.error);

  const meta = readPluginMeta();
  if (!meta) return errJson(404, "plugin_not_bundled");

  const lic = await getLicenseInfo();
  const required = process.env.LICENSE_REQUIRED === "1";
  // CR-05: فقط بسته‌ای عرضه می‌شود که امضای معتبر ناشر دارد و با فایل‌های فعلی می‌خواند (افزونه هم مستقل دوباره می‌سنجد)
  const rel = verifyBundledRelease();
  const signed = rel.ok && rel.manifest.version === meta.version;
  const blocked = required && !lic.licensed ? "برای دریافت نسخه‌ی جدید افزونه، لایسنس ابر باید فعال باشد." : !signed ? "بسته‌ی افزونه‌ی این ابر امضای دیجیتال معتبر ناشر ندارد؛ برای امنیت عرضه نمی‌شود. نسخه‌ی رسمی را نصب کنید." : "";
  const origin = cloudOrigin(req);

  return okJson({
    cloudVersion: APP_VERSION,
    plugin: {
      version: meta.version,
      requires: meta.requires,
      requiresPhp: meta.requiresPhp,
      tested: meta.tested,
      changelog: meta.changelog,
      package: blocked || !origin ? "" : `${origin}/api/wordpress/plugin`,
      blocked,
      release: signed && rel.ok ? { signed: true, keyId: rel.keyId, version: rel.manifest.version } : { signed: false },
    },
    license: {
      state: lic.state,
      required,
      plan: lic.plan,
      customer: lic.customer,
      domain: lic.domain,
      expiresAt: lic.expiresAt,
      updatesUntil: lic.updatesUntil,
      maxDomains: lic.maxDomains,
      usedDomains: lic.usedDomains,
      checkedAt: lic.checkedAt,
    },
  });
}

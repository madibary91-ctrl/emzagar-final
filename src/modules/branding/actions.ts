"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requireTeam } from "@/modules/tenancy/context";
import { logAudit } from "@/modules/audit/service";
import { getAllSettings, saveSettings } from "@/modules/settings/service";
import { HEX_RE, THEME_COOKIE, contrast, deleteLogoFile, saveLogoFile, sniffImage } from "./service";

export type BrandingState = { ok?: boolean; error?: string };
const MAX_LOGO = 400 * 1024;

export async function saveBrandingAction(_prev: BrandingState, formData: FormData): Promise<BrandingState> {
  const admin = await requireTeam("settings");
  const current = await getAllSettings(admin.workspaceId);
  const name = String(formData.get("site_name") || "").trim().slice(0, 40);
  const tagline = String(formData.get("brand_tagline") || "").trim().slice(0, 60);
  const primary = String(formData.get("brand_primary") || "").trim().toLowerCase();
  const accent = String(formData.get("brand_accent") || "").trim().toLowerCase();
  const theme = String(formData.get("brand_theme") || "light");
  const removeLogo = formData.get("removeLogo") === "on";
  const file = formData.get("logo");

  if (!name) return { error: "نام برند را وارد کنید" };
  if (!HEX_RE.test(primary) || !HEX_RE.test(accent)) return { error: "رنگ‌ها باید به‌صورت hex مانند #102c31 باشند" };
  if (contrast(primary, "#ffffff") < 4.5) return { error: "رنگ اصلی خیلی روشن است؛ متن سفید روی آن خوانا نیست. رنگ تیره‌تری انتخاب کنید." };
  if (contrast(primary, accent) < 3) return { error: "تضاد رنگ اصلی و رنگ تأکیدی کم است؛ دو رنگ را از هم دورتر انتخاب کنید." };
  if (!["light", "dark", "system"].includes(theme)) return { error: "حالت نمایش نامعتبر است" };

  const values: Parameters<typeof saveSettings>[0] = {
    site_name: name,
    brand_tagline: tagline,
    brand_primary: primary,
    brand_accent: accent,
    brand_theme: theme,
  };

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_LOGO) return { error: "حجم لوگو باید کمتر از ۴۰۰ کیلوبایت باشد" };
    const buf = Buffer.from(await file.arrayBuffer());
    const kind = sniffImage(buf); // اعتبارسنجی بر اساس محتوا، نه نام یا نوع اعلام‌شده
    if (!kind) return { error: "فقط تصویر PNG، JPG یا WebP مجاز است" };
    const saved = await saveLogoFile(buf, kind);
    if (current.brand_logo_file) await deleteLogoFile(current.brand_logo_file);
    values.brand_logo_file = saved;
    values.brand_logo_v = String(Date.now());
  } else if (removeLogo && current.brand_logo_file) {
    await deleteLogoFile(current.brand_logo_file);
    values.brand_logo_file = "";
    values.brand_logo_v = String(Date.now());
  }

  await saveSettings(values, admin.workspaceId);
  await logAudit({ workspaceId: admin.workspaceId, action: "branding.saved", userId: admin.id });
  revalidatePath("/", "layout");
  return { ok: true };
}

/** انتخاب تم توسط هر کاربر (کوکی ساده) */
export async function setThemeAction(theme: "light" | "dark") {
  if (theme !== "light" && theme !== "dark") return;
  const jar = await cookies();
  jar.set(THEME_COOKIE, theme, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
}

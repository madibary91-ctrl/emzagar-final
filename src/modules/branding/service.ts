import fs from "node:fs/promises";
import path from "node:path";
import { cookies } from "next/headers";
import { getAllSettings, getGlobalSetting } from "@/modules/settings/service";

export const THEME_COOKIE = "amz_theme";
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const DIR = path.join(process.cwd(), "storage", "branding");

export type ThemeMode = "light" | "dark" | "system";

export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** ترکیب دو رنگ برای ساخت سایه‌ی روشن‌تر از رنگ اصلی */
function mix(hex: string, withHex: string, ratio: number): string {
  const c = (i: number) => {
    const a = parseInt(hex.slice(i, i + 2), 16);
    const b = parseInt(withHex.slice(i, i + 2), 16);
    return Math.round(a * (1 - ratio) + b * ratio).toString(16).padStart(2, "0");
  };
  return `#${c(1)}${c(3)}${c(5)}`;
}

export interface Branding {
  name: string;
  tagline: string;
  logoUrl: string | null;
  primary: string;
  accent: string;
  defaultTheme: ThemeMode;
  /** CSS امن (فقط رنگ‌های hex اعتبارسنجی‌شده) */
  css: string;
}

const FALLBACK: Branding = {
  name: "امضاگیر",
  tagline: "",
  logoUrl: null,
  primary: "#102c31",
  accent: "#41e4ad",
  defaultTheme: "light",
  css: "",
};

export function buildCss(primary: string, accent: string): string {
  const soft = mix(primary, "#ffffff", 0.1);
  return `:root{--brand-ink:${primary};--brand-accent:${accent};--ink:${primary};--ink-2:${soft};--mint:${accent};--color-ink:${primary};--color-ink-soft:${soft};--color-mint:${accent};}`;
}

export async function getBranding(workspaceId = 0): Promise<Branding> {
  try {
    const s = await getAllSettings(workspaceId);
    // نام «پلتفرم» (صفحه‌ی اصلی، ورود، عنوان تب) از تنظیمات سراسری که نصب‌کننده/ویرایشگر صفحه‌ی اصلی می‌نویسد
    if (!workspaceId) s.site_name = (await getGlobalSetting("platform_name")) || s.site_name;
    const primary = HEX_RE.test(s.brand_primary) ? s.brand_primary.toLowerCase() : FALLBACK.primary;
    const accent = HEX_RE.test(s.brand_accent) ? s.brand_accent.toLowerCase() : FALLBACK.accent;
    const theme = (["light", "dark", "system"] as const).find((t) => t === s.brand_theme) ?? "light";
    return {
      name: s.site_name || FALLBACK.name,
      tagline: s.brand_tagline,
      logoUrl: s.brand_logo_file ? `/api/brand/logo?ws=${workspaceId}&v=${encodeURIComponent(s.brand_logo_v || "1")}` : null,
      primary,
      accent,
      defaultTheme: theme,
      css: buildCss(primary, accent),
    };
  } catch {
    // پیش از ساخت جدول‌ها (مثلاً هنگام build) از مقادیر پیش‌فرض استفاده می‌شود
    return { ...FALLBACK, css: buildCss(FALLBACK.primary, FALLBACK.accent) };
  }
}

/** تم نهایی: انتخاب کاربر (کوکی) و در غیاب آن پیش‌فرض مدیر */
export async function resolveTheme(defaultTheme: ThemeMode): Promise<ThemeMode> {
  const jar = await cookies();
  const v = jar.get(THEME_COOKIE)?.value;
  return v === "dark" || v === "light" ? v : defaultTheme;
}

/* ───────── ذخیره‌سازی لوگو (بیرون از public) ───────── */
export const LOGO_TYPES: Record<string, { ext: string; mime: string }> = {
  png: { ext: "png", mime: "image/png" },
  jpg: { ext: "jpg", mime: "image/jpeg" },
  webp: { ext: "webp", mime: "image/webp" },
};

export function sniffImage(buf: Buffer): keyof typeof LOGO_TYPES | null {
  if (buf.length > 12 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "png";
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 12 && buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "webp";
  return null;
}

export async function saveLogoFile(buf: Buffer, kind: keyof typeof LOGO_TYPES): Promise<string> {
  await fs.mkdir(DIR, { recursive: true });
  const name = `logo-${Date.now()}.${LOGO_TYPES[kind].ext}`;
  await fs.writeFile(path.join(DIR, name), buf, { mode: 0o600 });
  return name;
}

export async function deleteLogoFile(name: string) {
  if (!/^logo-\d+\.(png|jpg|webp)$/.test(name)) return;
  await fs.unlink(path.join(DIR, name)).catch(() => undefined);
}

export async function readLogoFile(name: string): Promise<{ data: Buffer; mime: string } | null> {
  const m = /^logo-\d+\.(png|jpg|webp)$/.exec(name);
  if (!m) return null;
  try {
    const data = await fs.readFile(path.join(DIR, name));
    const kind = Object.values(LOGO_TYPES).find((t) => t.ext === m[1]);
    return kind ? { data, mime: kind.mime } : null;
  } catch {
    return null;
  }
}

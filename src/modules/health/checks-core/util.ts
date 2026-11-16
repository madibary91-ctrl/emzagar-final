import fs from "node:fs/promises";
import path from "node:path";

export const fa = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
export const fmtBytes = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} گیگابایت` : `${Math.round(b / (1 << 20))} مگابایت`);
export const ageText = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "چند ثانیه";
  if (m < 60) return `${fa(m)} دقیقه`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${fa(h)} ساعت`;
  return `${fa(Math.floor(h / 24))} روز`;
};
export const isProd = () => process.env.NODE_ENV === "production";
/** مسیر نوشتنی بودن پوشه: یک فایل موقت می‌نویسد و پاک می‌کند */
export async function writable(dir: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const f = path.join(dir, `.health-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(f, "ok");
    await fs.unlink(f);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "خطا" };
  }
}

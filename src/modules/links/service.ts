import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts, shortLinks } from "@/db/schema";
import { getSetting } from "@/modules/settings/service";
import { getSecret } from "@/lib/secret";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // بدون حروف مشابه (i, l, o, 0, 1)
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;

export type ShortLink = typeof shortLinks.$inferSelect;

export function randomCode(len = 8): string {
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

export async function getLinkForContract(contractId: number): Promise<ShortLink | null> {
  const [row] = await db.select().from(shortLinks).where(eq(shortLinks.contractId, contractId));
  return row ?? null;
}

export async function getLinkByCode(code: string): Promise<ShortLink | null> {
  if (!SLUG_RE.test(code)) return null;
  const [row] = await db.select().from(shortLinks).where(eq(shortLinks.code, code));
  return row ?? null;
}

/** هر قرارداد یک لینک کوتاه دارد؛ اگر نبود با کد تصادفی ساخته می‌شود */
export async function ensureShortLink(contractId: number, createdBy?: number | null): Promise<ShortLink> {
  const existing = await getLinkForContract(contractId);
  if (existing) return existing;
  for (let i = 0; i < 6; i++) {
    const code = randomCode();
    try {
      const [row] = await db.insert(shortLinks).values({ contractId, code, createdBy: createdBy ?? null }).returning();
      return row;
    } catch {
      /* تکراری بودن کد؛ تلاش دوباره */
    }
  }
  throw new Error("ساخت لینک کوتاه ناموفق بود");
}

export async function shortUrl(code: string, fallbackOrigin = ""): Promise<string> {
  // آدرس پایه‌ی سایت متعلق به فضای کاری همان قرارداد است
  const [row] = await db
    .select({ w: contracts.workspaceId })
    .from(shortLinks)
    .innerJoin(contracts, eq(contracts.id, shortLinks.contractId))
    .where(eq(shortLinks.code, code));
  const base = ((await getSetting("app_url", row?.w ?? 0)) || fallbackOrigin).replace(/\/+$/, "");
  return `${base}/s/${code}`;
}

/* ───────── کوکی باز شدن قفل لینک (۳۰ دقیقه) ───────── */
const secret = () => getSecret();
export const UNLOCK_TTL = 30 * 60;
export const unlockCookieName = (code: string) => `amz_link_${code}`;
const mac = (code: string, exp: number) => crypto.createHmac("sha256", secret()).update(`link:${code}:${exp}`).digest("hex");

export function makeUnlockToken(code: string): string {
  const exp = Math.floor(Date.now() / 1000) + UNLOCK_TTL;
  return `${exp}.${mac(code, exp)}`;
}

export function verifyUnlockToken(code: string, token: string | undefined): boolean {
  if (!token) return false;
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now() / 1000) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(code, exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

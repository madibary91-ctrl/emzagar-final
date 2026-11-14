import fs from "node:fs/promises";
import path from "node:path";
import { desc, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { landingVersions } from "@/db/schema";
import { STORAGE_DIR } from "@/lib/config";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";
import { defaultDoc, sanitizeDoc, type LandingDoc } from "./schema";

const DRAFT_KEY = "landing_draft";
const PUBLISHED_KEY = "landing_published";
const MAX_VERSIONS = 30;

function parse(raw: string): LandingDoc | null {
  if (!raw) return null;
  try {
    return sanitizeDoc(JSON.parse(raw));
  } catch {
    return null;
  }
}
const ser = (doc: LandingDoc) => JSON.stringify(doc);

/** نسخه‌ی منتشرشده؛ اگر هنوز ساخته نشده یا دیتابیس آماده نیست، محتوای پیش‌فرض (هرگز خطا نمی‌دهد) */
export async function getPublishedLanding(siteName?: string): Promise<LandingDoc> {
  try {
    return parse(await getGlobalSetting(PUBLISHED_KEY)) ?? defaultDoc(siteName);
  } catch {
    return defaultDoc(siteName);
  }
}

export async function getDraftLanding(siteName?: string): Promise<{ doc: LandingDoc; unpublished: boolean }> {
  const [draftRaw, pubRaw] = await Promise.all([getGlobalSetting(DRAFT_KEY), getGlobalSetting(PUBLISHED_KEY)]);
  const pub = parse(pubRaw) ?? defaultDoc(siteName);
  const draft = parse(draftRaw);
  if (!draft) return { doc: pub, unpublished: false };
  return { doc: draft, unpublished: ser(draft) !== ser(pub) };
}

export async function saveDraftLanding(input: unknown): Promise<LandingDoc> {
  const doc = sanitizeDoc(input);
  await saveGlobalSetting(DRAFT_KEY, ser(doc));
  return doc;
}

/** انتشار: نسخه‌ی عمومی به‌روز می‌شود و یک نقطه‌ی بازگشت در تاریخچه ثبت می‌شود */
export async function publishLanding(input: unknown, userId: number, note: string): Promise<LandingDoc> {
  const doc = sanitizeDoc(input);
  const json = ser(doc);
  await saveGlobalSetting(DRAFT_KEY, json);
  await saveGlobalSetting(PUBLISHED_KEY, json);
  await db.insert(landingVersions).values({ doc: json, note: note.slice(0, 80), createdBy: userId });
  const old = await db.select({ id: landingVersions.id }).from(landingVersions).orderBy(desc(landingVersions.id)).offset(MAX_VERSIONS).limit(1);
  if (old[0]) await db.delete(landingVersions).where(lt(landingVersions.id, old[0].id + 1));
  return doc;
}

export async function listLandingVersions(): Promise<{ id: number; note: string; createdAt: Date }[]> {
  return db
    .select({ id: landingVersions.id, note: landingVersions.note, createdAt: landingVersions.createdAt })
    .from(landingVersions)
    .orderBy(desc(landingVersions.id))
    .limit(MAX_VERSIONS);
}

export async function getLandingVersion(id: number): Promise<LandingDoc | null> {
  const [row] = await db.select().from(landingVersions).where(eq(landingVersions.id, id));
  return row ? parse(row.doc) : null;
}

/** هنگام نصب: صفحه‌ی اصلی پیش‌فرض با نام سایت ساخته می‌شود (فقط اگر قبلاً نباشد) */
export async function ensureLandingDefaults(siteName: string): Promise<void> {
  if (await getGlobalSetting(PUBLISHED_KEY)) return;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(landingVersions);
  const doc = defaultDoc(siteName);
  const json = ser(doc);
  await saveGlobalSetting(PUBLISHED_KEY, json);
  await saveGlobalSetting(DRAFT_KEY, json);
  if (n === 0) await db.insert(landingVersions).values({ doc: json, note: "نسخه‌ی اولیه‌ی نصب" });
}

/* ───────── تصاویر بارگذاری‌شده (بیرون از public، با اعتبارسنجی محتوا) ───────── */
const DIR = path.join(STORAGE_DIR, "landing");
const NAME_RE = /^lp-\d{10,14}-[a-f0-9]{8}\.(png|jpg|webp)$/;
export const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export async function saveLandingImage(buf: Buffer, ext: "png" | "jpg" | "webp", rand: string): Promise<string> {
  await fs.mkdir(DIR, { recursive: true });
  const name = `lp-${Date.now()}-${rand}.${ext}`;
  await fs.writeFile(path.join(DIR, name), buf, { mode: 0o600 });
  return name;
}

export async function readLandingImage(name: string): Promise<{ data: Buffer; mime: string } | null> {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  try {
    return { data: await fs.readFile(path.join(DIR, name)), mime: IMAGE_MIME[m[1]] };
  } catch {
    return null;
  }
}

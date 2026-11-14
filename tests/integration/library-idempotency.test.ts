import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { templates, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { LIBRARY } from "@/modules/library";
import { addLibraryTemplateAction } from "@/modules/library/actions";
import { createSession } from "@/modules/auth/session";
import { createWorkspace } from "@/modules/tenancy/service";
import { freshBrowser, form, run, uniq } from "../helpers";

/** معماری: ۳۲ قالب «کد» (کاتالوگ مشترک و فقط‌خواندنی) است، نه ردیف دیتابیس؛ با «افزودن به قالب‌های من» برای همان فضای کاری کپی می‌شود */
async function ownerOf(name: string) {
  const [u] = await db.insert(users).values({ name, email: `${uniq("lib")}@example.com`, mobile: "09120000066", passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() }).returning();
  const ws = await createWorkspace(u.id, `فضای ${name}`);
  return { u, ws };
}
const login = async (u: typeof users.$inferSelect) => {
  freshBrowser();
  await createSession(u.id, u.passwordHash);
};
const add = (key: string) => run(() => addLibraryTemplateAction(form({ key })));
const libRows = (ws: number) => db.select().from(templates).where(and(eq(templates.workspaceId, ws), isNotNull(templates.libraryKey)));

let A: Awaited<ReturnType<typeof ownerOf>>;
let B: Awaited<ReturnType<typeof ownerOf>>;
beforeAll(async () => {
  A = await ownerOf("الف");
  B = await ownerOf("ب");
});
beforeEach(() => freshBrowser());

describe("کتابخانه‌ی ۳۲ قالب — کپی در هر فضای کاری و بدون تکرار", () => {
  it("کاتالوگ ۳۲ قالب با کلید یکتاست و ایجاد فضای کاری هیچ ردیف کتابخانه‌ای نمی‌سازد (فقط ۲ قالب نمونه)", async () => {
    expect(LIBRARY.length).toBe(32);
    expect(new Set(LIBRARY.map((t) => t.key)).size).toBe(32);
    expect((await db.select().from(templates).where(eq(templates.workspaceId, A.ws))).length).toBe(2);
    expect(await libRows(A.ws)).toHaveLength(0);
  });

  it("افزودن همه‌ی ۳۲ قالب، دو بار پشت‌سرهم: دقیقاً ۳۲ ردیف (تکراری نمی‌شود) و هر بار به همان قالب هدایت می‌شود", async () => {
    await login(A.u);
    const first = new Map<string, string>();
    for (const t of LIBRARY) first.set(t.key, (await add(t.key)).redirect!);
    for (const t of LIBRARY) expect((await add(t.key)).redirect, t.key).toBe(first.get(t.key));
    const rows = await libRows(A.ws);
    expect(rows).toHaveLength(32);
    expect(new Set(rows.map((r) => r.libraryKey)).size).toBe(32);
    for (const r of rows) {
      expect(r.body).toContain("[CONTRACT_NUMBER]");
      expect(r.body).not.toMatch(/\(\([a-z0-9_]+\|/); // جاهای خالی ((کلید|عنوان)) باقی نمانده
    }
  });

  it("کلیک‌های هم‌زمان روی یک قالب فقط یک کپی می‌سازند (ایندکس یکتا + ON CONFLICT)", async () => {
    await login(B.u);
    const key = LIBRARY[3].key;
    const res = await Promise.all(Array.from({ length: 8 }, () => add(key)));
    expect(new Set(res.map((r) => r.redirect)).size).toBe(1);
    expect((await libRows(B.ws)).filter((r) => r.libraryKey === key)).toHaveLength(1);
  });

  it("هر فضای کاری کپی مستقل دارد (مشترک نیست): ویرایش در الف به ب نمی‌رسد و حذف/افزودن دوباره تکرار نمی‌سازد", async () => {
    const key = LIBRARY[0].key;
    await login(B.u);
    await add(key);
    const [a] = await db.select().from(templates).where(and(eq(templates.workspaceId, A.ws), eq(templates.libraryKey, key)));
    const [b] = await db.select().from(templates).where(and(eq(templates.workspaceId, B.ws), eq(templates.libraryKey, key)));
    expect(a.id).not.toBe(b.id);
    await db.update(templates).set({ body: "<p>ویرایش اختصاصی الف</p>" }).where(eq(templates.id, a.id));
    expect((await db.select().from(templates).where(eq(templates.id, b.id)))[0].body).not.toContain("ویرایش اختصاصی");

    await db.delete(templates).where(eq(templates.id, b.id));
    await add(key);
    expect((await libRows(B.ws)).filter((r) => r.libraryKey === key)).toHaveLength(1);
  });

  it("خود دیتابیس تکرار را رد می‌کند، ولی قالب‌های دست‌ساز (library_key خالی) محدودیتی ندارند", async () => {
    const key = LIBRARY[5].key;
    await login(A.u);
    await add(key);
    await expect(db.insert(templates).values({ workspaceId: A.ws, title: "تکراری", body: "<p>x</p>", libraryKey: key })).rejects.toThrow();
    await db.insert(templates).values([{ workspaceId: A.ws, title: "دست‌ساز ۱", body: "<p>x</p>" }, { workspaceId: A.ws, title: "دست‌ساز ۲", body: "<p>x</p>" }]);
  });

  it("کلید ناشناخته چیزی نمی‌سازد", async () => {
    await login(A.u);
    const before = (await db.select().from(templates).where(eq(templates.workspaceId, A.ws))).length;
    expect((await add("no-such-template")).redirect).toBe("/admin/library");
    expect((await db.select().from(templates).where(eq(templates.workspaceId, A.ws))).length).toBe(before);
  });
});

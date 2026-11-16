import { sql } from "drizzle-orm";
import { db } from "@/db";
import { users, templates, products, workspaces, workspaceMembers } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { devFlag } from "@/lib/dev-flags";
import { createWorkspace } from "@/modules/tenancy/service";
import { saveSettings } from "@/modules/settings/service";

let seeded = false;
let seeding: Promise<void> | null = null;

/**
 * راه‌اندازی اولیه‌ی داده‌ها:
 *  ۱) مهاجرت خودکار داده‌های نسخه‌ی تک‌کاربره به یک فضای کاری پیش‌فرض (فقط یک بار، idempotent)
 *  ۲) داده‌ی نمایشی (دمو) فقط وقتی SEED_DEMO=1 باشد و دیتابیس کاملاً خالی باشد.
 *     (رمزهای دمو عمومی‌اند؛ هرگز در محیط واقعی فعال نکنید.)
 */
export async function ensureSeed() {
  if (seeded) return;
  // درخواست‌های همزمان یک اجرای واحد را به اشتراک می‌گذارند (جلوگیری از ساخت دوباره‌ی داده)
  seeding ??= runSeed().finally(() => {
    seeding = null;
  });
  return seeding;
}

async function runSeed() {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  if (count > 0) {
    await migrateLegacyData();
    seeded = true;
    return;
  }
  if (devFlag("SEED_DEMO")) await seedDemo();
  seeded = true;
}

async function migrateLegacyData() {
  const [{ n: wsCount }] = await db.select({ n: sql<number>`count(*)::int` }).from(workspaces);
  if (wsCount > 0) return;
  const legacyAdmins = await db.select().from(users).where(sql`${users.role} = 'admin'`).orderBy(users.id);
  if (legacyAdmins.length === 0) return;
  const owner = legacyAdmins[0];
  const [{ n: hasData }] = await db.select({ n: sql<number>`count(*)::int` }).from(templates);
  const wsId = await createWorkspace(owner.id, "فضای کاری اصلی");
  // createWorkspace قالب‌های نمونه می‌سازد؛ اگر داده‌ی قدیمی هست، آن‌ها را تکراری نکنیم
  if (hasData > 0) await db.execute(sql`delete from templates where workspace_id = ${wsId}`);
  for (const a of legacyAdmins.slice(1)) {
    await db.insert(workspaceMembers).values({ workspaceId: wsId, userId: a.id, role: "admin" }).onConflictDoNothing();
  }
  const others = await db.select().from(users).where(sql`${users.role} <> 'admin'`);
  for (const u of others) {
    await db.insert(workspaceMembers).values({ workspaceId: wsId, userId: u.id, role: "client" }).onConflictDoNothing();
  }
  for (const t of ["templates", "contracts", "notifications", "products", "orders", "webhook_endpoints", "api_keys", "audit_logs"]) {
    await db.execute(sql.raw(`update ${t} set workspace_id = ${wsId} where workspace_id = 0`));
  }
  // تنظیمات قدیمی (جدول settings) به تنظیمات فضای کاری منتقل می‌شود
  const old = await db.execute(sql`select key, value from settings where key <> 'cron_secret'`);
  const values: Record<string, string> = {};
  for (const r of old.rows as { key: string; value: string }[]) values[r.key] = r.value;
  await saveSettings(values, wsId);
}

async function seedDemo() {
  const [admin, ali, sara, finance] = await db
    .insert(users)
    .values([
      { name: "مدیر سیستم", email: "admin@example.com", mobile: "09120000000", passwordHash: hashPassword("admin123"), role: "admin", emailVerifiedAt: new Date() },
      { name: "علی رضایی", email: "ali@example.com", mobile: "09121111111", passwordHash: hashPassword("user123"), role: "user", emailVerifiedAt: new Date() },
      { name: "سارا احمدی", email: "sara@example.com", mobile: "09122222222", passwordHash: hashPassword("user123"), role: "user", emailVerifiedAt: new Date() },
      { name: "بخش مالی", email: "finance@example.com", mobile: "09123333333", passwordHash: hashPassword("user123"), role: "user", emailVerifiedAt: new Date() },
    ])
    .returning();
  const wsId = await createWorkspace(admin.id, "امضاگیر");
  await db.insert(workspaceMembers).values([
    { workspaceId: wsId, userId: finance.id, role: "admin" },
    { workspaceId: wsId, userId: ali.id, role: "client" },
    { workspaceId: wsId, userId: sara.id, role: "client" },
  ]);
  const tpls = await db.select().from(templates).where(sql`${templates.workspaceId} = ${wsId}`).orderBy(templates.id);
  await db.insert(products).values([
    { workspaceId: wsId, title: "طراحی وب‌سایت شرکتی", description: "طراحی و راه‌اندازی وب‌سایت با پشتیبانی سه‌ماهه", price: 15000000, templateId: tpls[0]?.id ?? null },
    { workspaceId: wsId, title: "مشاوره‌ی محرمانه‌ی کسب‌وکار", description: "جلسات مشاوره با تعهد محرمانگی", price: 3000000, templateId: tpls[1]?.id ?? null },
  ]);
}

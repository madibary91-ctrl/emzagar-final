import { db, DatabaseNotConfiguredError } from "@/db";
import { sql } from "drizzle-orm";
import { simulatorUrl } from "@/lib/external";

export const dynamic = "force-dynamic";

export async function GET() {
  // وقتی سرویس‌های بیرونی به شبیه‌ساز وصل‌اند، نشانه‌اش اینجا دیده می‌شود (برای ربات تست و جلوگیری از اشتباه در production)
  const simulator = simulatorUrl()?.origin ?? null;
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, simulator });
  } catch (e) {
    // پیش از نصب هنوز دیتابیسی تنظیم نشده؛ این حالت خطا نیست (سرور سالم است و منتظر نصب‌کننده)
    if (e instanceof DatabaseNotConfiguredError) return Response.json({ ok: true, installed: false, simulator });
    return Response.json({ ok: false }, { status: 500 });
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { messengerBots } from "@/db/schema";
import { handleUpdate } from "@/modules/messengers/bot";
import type { TgUpdate } from "@/modules/messengers/client";
import { headerSecretFor, safeEqual } from "@/modules/messengers/util";

export const dynamic = "force-dynamic";

/**
 * وب‌هوک ربات پیام‌رسان (تلگرام/بله). راز ۱۹۲بیتی داخل آدرس است؛ برای تلگرام هدر
 * X-Telegram-Bot-Api-Secret-Token (مشتق‌شده از همان راز) هم الزامی است. هر ناهمخوانی ⇒ ۴۰۴ (بدون افشای وجود ربات).
 * پاسخ همیشه سریع و ۲۰۰ است تا پیام‌رسان آپدیت را دوباره نفرستد؛ آپدیت تکراری هم در handleUpdate رد می‌شود.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ secret: string }> }) {
  const { secret } = await ctx.params;
  if (!/^[a-f0-9]{48}$/.test(secret)) return new NextResponse(null, { status: 404 });
  const [bot] = await db.select().from(messengerBots).where(and(eq(messengerBots.webhookSecret, secret), eq(messengerBots.active, true)));
  if (!bot) return new NextResponse(null, { status: 404 });
  const hdr = req.headers.get("x-telegram-bot-api-secret-token");
  const expected = headerSecretFor(secret);
  if (bot.provider === "telegram" ? !hdr || !safeEqual(hdr, expected) : !!hdr && !safeEqual(hdr, expected)) return new NextResponse(null, { status: 404 });

  const raw = await req.text();
  if (raw.length > 262_144) return new NextResponse(null, { status: 413 });
  let update: TgUpdate;
  try {
    update = JSON.parse(raw) as TgUpdate;
  } catch {
    return NextResponse.json({ ok: true });
  }
  if (!update || typeof update !== "object" || typeof update.update_id !== "number") return NextResponse.json({ ok: true });
  await handleUpdate(bot.id, update);
  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/modules/auth/session";
import { listNotifications, markRead, unreadCount } from "@/modules/inbox/service";

export const dynamic = "force-dynamic";

/** زنگوله: فهرست اعلان‌های اخیر + تعداد خوانده‌نشده (برای رأس صفحه) */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const countOnly = new URL(req.url).searchParams.get("count") === "1";
  const unread = await unreadCount(user.id);
  if (countOnly) return NextResponse.json({ unread }, { headers: { "Cache-Control": "private, no-store" } });
  const items = await listNotifications(user.id, { limit: 12 });
  return NextResponse.json(
    { unread, items: items.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, href: n.href, read: !!n.readAt, at: n.createdAt.toISOString() })) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/** body: { ids?: number[] } — بدون ids یعنی همه خوانده شوند */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n)).slice(0, 200) : undefined;
  const changed = await markRead(user.id, ids);
  return NextResponse.json({ ok: true, changed, unread: await unreadCount(user.id) });
}

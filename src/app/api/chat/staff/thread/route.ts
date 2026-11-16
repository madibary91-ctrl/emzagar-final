import { fail, getStaff, json, staffConversation } from "@/modules/chat/actor";
import { parseQueue } from "@/modules/chat/api";
import { staffThread } from "@/modules/chat/service";

export const dynamic = "force-dynamic";

/** گفتگوی کامل (شامل یادداشت‌های داخلی) + زمینه‌ی مشتری/قرارداد برای پشتیبان */
export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const staff = await getStaff(parseQueue(sp.get("queue")));
    if (!staff) return json({ error: "forbidden", message: "دسترسی ندارید" }, 403);
    const conv = await staffConversation(staff, sp.get("c") || "");
    if (!conv) return json({ error: "not_found", message: "گفتگو یافت نشد" }, 404);
    return json(await staffThread(staff, conv));
  } catch (e) {
    return fail(e);
  }
}

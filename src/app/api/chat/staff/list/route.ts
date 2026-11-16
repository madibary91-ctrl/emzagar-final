import { fail, getStaff, json } from "@/modules/chat/actor";
import { agentsOnline, staffList, touchAgent, agentScope } from "@/modules/chat/service";
import { parseFilter, parseQueue } from "@/modules/chat/api";

export const dynamic = "force-dynamic";

/** فهرست گفتگوهای صف پشتیبان (پلتفرم یا تیم فضای کاری فعال) */
export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const staff = await getStaff(parseQueue(sp.get("queue")));
    if (!staff) return json({ error: "forbidden", message: "دسترسی ندارید" }, 403);
    await touchAgent(staff.userId, agentScope(staff.queue, staff.workspaceId));
    const list = await staffList(staff, { filter: parseFilter(sp.get("filter")), q: (sp.get("q") || "").trim().slice(0, 80) || undefined });
    return json({ ...list, online: await agentsOnline(staff.queue, staff.workspaceId) });
  } catch (e) {
    return fail(e);
  }
}

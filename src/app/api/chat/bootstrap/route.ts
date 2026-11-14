import { buildBootstrap, parseWidgetContext } from "@/modules/chat/api";
import { fail, getRequester, json } from "@/modules/chat/actor";

export const dynamic = "force-dynamic";

/** وضعیت اولیه‌ی ویجت: مقصد گفتگو، آنلاین‌بودن پشتیبانی و گفتگوی جاری مشتری (اگر باشد) */
export async function GET(req: Request) {
  try {
    const sp = Object.fromEntries(new URL(req.url).searchParams);
    const input = parseWidgetContext(sp);
    const who = await getRequester(input.kind, false);
    return json(await buildBootstrap(who, input));
  } catch (e) {
    return fail(e);
  }
}

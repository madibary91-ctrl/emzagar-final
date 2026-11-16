import { authenticateApi } from "@/modules/api/service";
import { errJson, failJson, okJson } from "@/modules/connect/http";
import { disconnectByKey } from "@/modules/connect/service";

export const dynamic = "force-dynamic";

/** هنگام حذف افزونه از وردپرس فراخوانی می‌شود: کلید باطل و اتصال بسته می‌شود (داده‌ها حفظ می‌شود) */
export async function POST(req: Request) {
  const auth = await authenticateApi(req);
  if (!auth.ok) return errJson(auth.status, auth.error);
  try {
    await disconnectByKey(auth.keyId, auth.workspaceId);
    return okJson({});
  } catch (e) {
    return failJson(e);
  }
}

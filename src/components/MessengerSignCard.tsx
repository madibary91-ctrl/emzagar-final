import { MessageCircle } from "lucide-react";
import { botsForWorkspace } from "@/modules/messengers/service";
import { deepLink, makeGuestLinkCode, providerLabel } from "@/modules/messengers/util";

/**
 * کارت صفحه‌ی لینک امضا: امضاکننده با یک کلیک ربات (بله/تلگرام) را باز می‌کند و پس از «Start» وضعیت قرارداد، یادآوری‌ها و
 * لینک امضا را همان‌جا می‌گیرد. کد داخل لینک امضای HMAC و کوتاه‌عمر است و فقط چت را به همین امضاکننده وصل می‌کند.
 */
export default async function MessengerSignCard({ userId, workspaceId }: { userId: number; workspaceId: number }) {
  let bots: Awaited<ReturnType<typeof botsForWorkspace>> = [];
  try {
    bots = await botsForWorkspace(workspaceId);
  } catch {
    return null;
  }
  if (!bots.length) return null;
  const code = makeGuestLinkCode(userId);
  return (
    <section className="panel-solid mt-4 p-4 sm:p-5" aria-label="دریافت در پیام‌رسان">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-ink text-mint"><MessageCircle size={17} aria-hidden="true" /></span>
        <div>
          <h2 className="text-sm font-black">پیگیری در پیام‌رسان</h2>
          <p className="text-xs text-ink/72">وضعیت قرارداد، یادآوری و نسخه‌ی نهایی را در بله یا تلگرام بگیرید؛ بدون نصب برنامه‌ی جدید.</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {bots.map((b) => (
          <a key={b.id} href={deepLink(b.provider, b.botUsername, code)} target="_blank" rel="noopener noreferrer" className="btn-secondary !py-2 text-xs">
            باز کردن در {providerLabel(b.provider)}
          </a>
        ))}
      </div>
    </section>
  );
}

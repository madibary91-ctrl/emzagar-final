import { MessageCircle } from "lucide-react";
import { AddBotForm, BotCard } from "@/components/MessengerPanels";
import { faTime } from "@/lib/jalali";
import { listBots, recentMessengerLog } from "@/modules/messengers/service";
import { providerLabel } from "@/modules/messengers/util";

const KIND: Record<string, string> = { notice: "اعلان", signlink: "لینک امضا", otp: "کد تأیید", finalcopy: "نسخه‌ی نهایی", reply: "پاسخ ربات", test: "آزمایشی" };

/** نمای مشترک مدیریت ربات‌ها: «ربات پلتفرم» (مدیر کل) و «ربات اختصاصی فضای کاری» (مدیر تیم) */
export default async function MessengersAdminView({ scope, workspaceId }: { scope: "platform" | "workspace"; workspaceId: number | null }) {
  const [bots, log] = await Promise.all([listBots(workspaceId), recentMessengerLog(workspaceId, 25)]);
  return (
    <>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><MessageCircle size={22} />ربات‌های پیام‌رسان (بله و تلگرام)</h1>
      <p className="mb-5 max-w-3xl text-xs leading-7 text-ink/72">
        {scope === "platform"
          ? "ربات پلتفرم برای همه‌ی کاربران است: لینک امضا، وضعیت قرارداد، یادآوری و اعلان‌ها به‌جای پیامک و ایمیل در بله/تلگرام می‌رسد. "
          : "ربات اختصاصی (برندشده‌ی) کسب‌وکار شما؛ فقط قراردادهای همین فضای کاری را نشان می‌دهد. "}
        امضاکننده‌ها با یک کلیک (و دکمه‌ی «اشتراک شماره») وصل می‌شوند و کد تأیید امضا هم می‌تواند به‌جای پیامک از همین کانال برسد.
      </p>

      <div className="space-y-4">
        {bots.map((b) => (
          <BotCard key={b.id} scope={scope} bot={{ ...b, lastEventAt: b.lastEventAt ? b.lastEventAt.toISOString() : null }} />
        ))}
        {bots.length === 0 && <div className="panel-solid p-8 text-center text-xs text-ink/72">هنوز رباتی ثبت نشده است. از فرم زیر یک ربات اضافه کنید.</div>}
      </div>

      <div className="mt-5"><AddBotForm scope={scope} /></div>

      <section className="panel-solid mt-5 p-5 text-xs leading-7 text-ink/80">
        <h2 className="mb-2 text-sm font-black">راه‌اندازی در ۳ دقیقه</h2>
        <ol className="list-decimal space-y-1 pr-5">
          <li>در بله به «پدر بات‌ها» (@botfather) یا در تلگرام به @BotFather پیام بدهید و با /newbot ربات بسازید؛ توکن را کپی کنید.</li>
          <li>توکن را بالا وارد کنید. اگر سایت شما HTTPS دارد «وب‌هوک»، وگرنه «Polling» را بگذارید.</li>
          <li>از «حساب من ← پیام‌رسان‌ها» به ربات وصل شوید و «ارسال پیام آزمایشی» را بزنید.</li>
        </ol>
        <p className="mt-2 rounded-lg bg-emerald-50 p-3 text-emerald-900">💬 اعلان گفتگوی آنلاین: پیام جدید مشتری به پشتیبان‌های وصل‌شده در بله/تلگرام می‌رسد (فوری اگر آنلاین نیستند، وگرنه پس از ۹۰ ثانیه بی‌پاسخی). با دکمه‌ی «پاسخ از همین‌جا» می‌توانند مستقیم از ربات پاسخ دهند؛ دستورهای /chats و /done. برای ایتا در «اعلان پیام‌رسان‌ها» مقصد بسازید و رویداد گفتگوی آنلاین را انتخاب کنید.</p>
        <p className="mt-2 text-ink/72">نکته‌ی بله: ظرفیت ارسال ربات‌های معمولی بله بر پایه‌ی تعامل کاربران با ربات است؛ برای اعلان‌های انبوه می‌توان از «API کسب‌وکاری بله» استفاده کرد.</p>
      </section>

      <section className="panel-solid mt-5 overflow-x-auto">
        <h2 className="px-5 pt-5 font-bold">آخرین ارسال‌ها</h2>
        <table className="w-full">
          <thead><tr><th className="th">زمان</th><th className="th">ربات</th><th className="th">نوع</th><th className="th">نتیجه</th></tr></thead>
          <tbody>
            {log.map((l) => (
              <tr key={l.id} className="border-t border-ink/[.07]">
                <td className="td whitespace-nowrap text-xs">{faTime(l.createdAt)}</td>
                <td className="td text-xs">{providerLabel(l.provider)} <span dir="ltr" className="font-mono">@{l.botUsername}</span></td>
                <td className="td text-xs">{KIND[l.kind] ?? l.kind}</td>
                <td className={`td text-xs ${l.status === "sent" ? "text-emerald-700" : "text-rose-600"}`}>{l.status === "sent" ? "موفق" : `ناموفق: ${l.error}`}</td>
              </tr>
            ))}
            {log.length === 0 && <tr><td colSpan={4} className="py-10 text-center text-xs text-ink/72">هنوز ارسالی انجام نشده است.</td></tr>}
          </tbody>
        </table>
      </section>
    </>
  );
}

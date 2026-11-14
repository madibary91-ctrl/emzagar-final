"use client";

import { useActionState, useState, useTransition } from "react";
import { BellOff, Bell, CheckCircle2, ExternalLink, Link2Off, RefreshCw, Send, ShieldCheck, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { addBotAction, botOpAction, createLinkAction, muteChatAction, unlinkChatAction, type MsgState } from "@/modules/messengers/actions";
import { MESSENGER_PROVIDERS, providerLabel } from "@/modules/messengers/meta";

export type BotView = {
  id: number;
  provider: string;
  label: string;
  botUsername: string;
  botName: string;
  apiBase: string;
  mode: string;
  active: boolean;
  otpMode: string;
  sendPdf: boolean;
  status: string;
  lastError: string;
  linked: number;
  verified: number;
  sent7: number;
  failed7: number;
  lastEventAt: string | null;
};

function Notice({ s }: { s: MsgState }) {
  if (s.error) return <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{s.error}</p>;
  if (s.ok && s.info) return <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">{s.info}</p>;
  return null;
}

export function AddBotForm({ scope }: { scope: "platform" | "workspace" }) {
  const [state, action, pending] = useActionState<MsgState, FormData>(addBotAction, {});
  const [provider, setProvider] = useState("bale");
  const meta = MESSENGER_PROVIDERS.find((p) => p.id === provider)!;
  return (
    <form action={action} className="card grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="scope" value={scope} />
      <h2 className="font-bold sm:col-span-2">افزودن ربات</h2>
      <div>
        <label htmlFor="mb-provider" className="label">پیام‌رسان</label>
        <select id="mb-provider" name="provider" value={provider} onChange={(e) => setProvider(e.target.value)} className="input">
          {MESSENGER_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="mb-label" className="label">نام نمایشی (اختیاری)</label>
        <input id="mb-label" name="label" className="input" placeholder="مثلاً ربات امضا" maxLength={80} />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="mb-token" className="label">توکن ربات</label>
        <input id="mb-token" name="token" type="password" dir="ltr" className="input" placeholder="123456789:AAH…" autoComplete="off" required />
        <p className="mt-1.5 text-xs text-ink/72">{meta.hint}. توکن رمزنگاری می‌شود و هرگز دوباره نمایش داده نخواهد شد.</p>
      </div>
      <div>
        <label htmlFor="mb-mode" className="label">روش دریافت پیام کاربران</label>
        <select id="mb-mode" name="mode" className="input" defaultValue="webhook">
          <option value="webhook">وب‌هوک (پیشنهادی؛ نیاز به HTTPS عمومی)</option>
          <option value="polling">پرسش دوره‌ای / Polling (بدون نیاز به HTTPS)</option>
        </select>
      </div>
      {provider === "telegram" && (
        <div>
          <label htmlFor="mb-api" className="label">آدرس رله‌ی API (اختیاری)</label>
          <input id="mb-api" name="apiBase" dir="ltr" className="input" placeholder="https://tg-relay.example.com" />
          <p className="mt-1.5 text-xs text-ink/72">سرور داخل ایران به api.telegram.org دسترسی ندارد؛ رله‌ی خودتان (مثلاً Cloudflare Worker) را بدهید.</p>
        </div>
      )}
      <div className="sm:col-span-2"><Notice s={state} /></div>
      <div className="sm:col-span-2"><button disabled={pending} className="btn-primary">{pending ? "در حال اتصال…" : "افزودن و اتصال"}</button></div>
    </form>
  );
}

function OpButton({ scope, id, op, children, confirm, className = "btn-secondary" }: { scope: string; id: number; op: string; children: React.ReactNode; confirm?: string; className?: string }) {
  const [, action, pending] = useActionState<MsgState, FormData>(botOpAction, {});
  return (
    <form action={action} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="op" value={op} />
      <button disabled={pending} className={`${className} !px-3 !py-1.5 text-xs`}>{children}</button>
    </form>
  );
}

const STATUS_STYLE: Record<string, string> = { connected: "bg-emerald-50 text-emerald-800", error: "bg-rose-50 text-rose-700", new: "bg-stone-100 text-stone-600" };
const STATUS_TEXT: Record<string, string> = { connected: "متصل", error: "خطا", new: "تازه" };

export function BotCard({ bot, scope }: { bot: BotView; scope: "platform" | "workspace" }) {
  const [state, action, pending] = useActionState<MsgState, FormData>(botOpAction, {});
  const [testState, testAction, testing] = useActionState<MsgState, FormData>(botOpAction, {});
  return (
    <div className="panel-solid space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <b className="text-sm">{bot.label || bot.botName || `ربات ${providerLabel(bot.provider)}`}</b>
          <span className={`badge mr-2 ${STATUS_STYLE[bot.status] ?? STATUS_STYLE.new}`}>{STATUS_TEXT[bot.status] ?? bot.status}</span>
          {!bot.active && <span className="badge mr-1 bg-stone-100 text-stone-600">غیرفعال</span>}
          <div className="mt-1 text-xs text-ink/72">
            {providerLabel(bot.provider)} • <span dir="ltr" className="font-mono">@{bot.botUsername || "—"}</span> • {bot.mode === "polling" ? "Polling" : "وب‌هوک"}
            {bot.apiBase && <> • رله: <span dir="ltr" className="font-mono">{new URL(bot.apiBase).host}</span></>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <OpButton scope={scope} id={bot.id} op="connect"><RefreshCw size={13} className="ml-1 inline" />اتصال مجدد</OpButton>
          <OpButton scope={scope} id={bot.id} op="toggle">{bot.active ? "غیرفعال‌سازی" : "فعال‌سازی"}</OpButton>
          <OpButton scope={scope} id={bot.id} op="delete" confirm="این ربات و همه‌ی اتصال‌های کاربران به آن حذف شود؟" className="btn-danger"><Trash2 size={13} className="ml-1 inline" />حذف</OpButton>
        </div>
      </div>
      {bot.lastError && bot.status === "error" && <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{bot.lastError}</p>}
      <dl className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
        {[
          ["گفتگوی متصل", bot.linked],
          ["شماره‌ی تأییدشده", bot.verified],
          ["ارسال موفق (۷ روز)", bot.sent7],
          ["ارسال ناموفق (۷ روز)", bot.failed7],
        ].map(([k, v]) => (
          <div key={String(k)} className="rounded-2xl bg-stone-50 p-3"><dd className="text-lg font-black">{Number(v).toLocaleString("fa-IR")}</dd><dt className="text-[11px] text-ink/72">{k}</dt></div>
        ))}
      </dl>
      <form action={action} className="grid gap-3 border-t border-ink/[.07] pt-4 sm:grid-cols-3">
        <input type="hidden" name="scope" value={scope} />
        <input type="hidden" name="id" value={bot.id} />
        <input type="hidden" name="op" value="settings" />
        <div>
          <label className="label" htmlFor={`otp-${bot.id}`}>کد تأیید امضا</label>
          <select id={`otp-${bot.id}`} name="otpMode" defaultValue={bot.otpMode} className="input">
            <option value="prefer">اول پیام‌رسان؛ پیامک فقط اگر نرسید (کم‌هزینه)</option>
            <option value="both">هم پیام‌رسان و هم پیامک</option>
            <option value="off">فقط پیامک</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`mode-${bot.id}`}>روش دریافت</label>
          <select id={`mode-${bot.id}`} name="mode" defaultValue={bot.mode} className="input">
            <option value="webhook">وب‌هوک</option>
            <option value="polling">Polling</option>
          </select>
        </div>
        <label className="flex items-end gap-2 pb-3 text-xs"><input type="checkbox" name="sendPdf" defaultChecked={bot.sendPdf} />ارسال فایل PDF نهایی داخل پیام‌رسان</label>
        {bot.sendPdf === false && <p className="text-[11px] text-ink/72 sm:col-span-3">با خاموش بودن، فقط لینک امن نسخه‌ی نهایی فرستاده می‌شود (فایل قرارداد از سرور پیام‌رسان عبور نمی‌کند).</p>}
        <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
          <button disabled={pending} className="btn-primary !py-2 text-xs">ذخیره‌ی تنظیمات</button>
          <Notice s={state} />
        </div>
      </form>
      <form action={testAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="scope" value={scope} />
        <input type="hidden" name="id" value={bot.id} />
        <input type="hidden" name="op" value="test" />
        <button disabled={testing} className="btn-secondary !py-2 text-xs"><Send size={13} className="ml-1 inline" />ارسال پیام آزمایشی به خودم</button>
        <Notice s={testState} />
      </form>
    </div>
  );
}

/* ───────── «حساب من»: اتصال به پیام‌رسان ───────── */

export type AccountBot = { id: number; provider: string; label: string; botUsername: string };
export type AccountChat = { id: number; provider: string; botUsername: string; username: string; displayName: string; verifiedMobile: string; muted: boolean; blocked: boolean };

export function AccountMessengers({ bots, chats }: { bots: AccountBot[]; chats: AccountChat[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<MsgState | null>(null);
  const connect = (botId: number) =>
    start(async () => {
      const r = await createLinkAction(botId);
      setMsg(r);
      if (r.ok && r.url) window.open(r.url, "_blank", "noopener,noreferrer");
    });
  return (
    <div className="space-y-4">
      {bots.length === 0 ? (
        <p className="text-xs text-ink/72">هنوز رباتی توسط مدیر سامانه فعال نشده است.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {bots.map((b) => (
            <button key={b.id} type="button" disabled={pending} onClick={() => connect(b.id)} className="btn-secondary !py-2 text-xs">
              <ExternalLink size={13} className="ml-1 inline" />اتصال به {providerLabel(b.provider)}{b.label ? ` — ${b.label}` : ` (@${b.botUsername})`}
            </button>
          ))}
          <button type="button" onClick={() => router.refresh()} className="btn-ghost !py-2 text-xs"><RefreshCw size={13} className="ml-1 inline" />بررسی اتصال</button>
        </div>
      )}
      {msg?.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{msg.error}</p>}
      {msg?.ok && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">پیام‌رسان باز شد؛ روی «Start / شروع» بزنید و سپس «بررسی اتصال» را بزنید. لینک تا ۱۰ دقیقه و فقط یک‌بار معتبر است.</p>}
      {chats.length > 0 && (
        <ul className="divide-y divide-ink/[.07] rounded-2xl border border-ink/[.08]">
          {chats.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-xs">
              <div>
                <b>{providerLabel(c.provider)}</b> — {c.displayName || c.username || "کاربر"} {c.username && <span dir="ltr" className="font-mono text-ink/72">@{c.username}</span>}
                <div className="mt-1 flex flex-wrap gap-2 text-ink/72">
                  {c.verifiedMobile ? <span className="inline-flex items-center gap-1 text-emerald-700"><ShieldCheck size={13} />شماره تأیید شده</span> : <span>شماره تأیید نشده (در ربات /verify)</span>}
                  {c.muted && <span>• بی‌صدا</span>}
                  {c.blocked && <span className="text-rose-600">• ربات را مسدود کرده‌اید</span>}
                </div>
              </div>
              <div className="flex gap-2">
                <form action={muteChatAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="muted" value={c.muted ? "0" : "1"} />
                  <button className="btn-secondary !px-3 !py-1.5 text-xs">{c.muted ? <><Bell size={13} className="ml-1 inline" />فعال‌سازی اعلان</> : <><BellOff size={13} className="ml-1 inline" />بی‌صدا</>}</button>
                </form>
                <form action={unlinkChatAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <button className="btn-danger !px-3 !py-1.5 text-xs"><Link2Off size={13} className="ml-1 inline" />قطع اتصال</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="flex items-start gap-2 text-[11px] leading-6 text-ink/72"><CheckCircle2 size={14} className="mt-1 shrink-0" />لینک امضا، وضعیت قرارداد و اعلان‌ها در پیام‌رسان می‌رسد. اگر شماره‌ی موبایل خود را هم با دکمه‌ی «اشتراک شماره» در ربات تأیید کنید، کد تأیید امضا نیز همان‌جا می‌آید.</p>
    </div>
  );
}

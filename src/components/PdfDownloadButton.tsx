"use client";

import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Copy, ExternalLink, Eye, LoaderCircle } from "lucide-react";
import { androidChromeIntent, detectInAppBrowser, isAndroid, withQuery } from "@/lib/inapp-browser";
import { NET_MESSAGES, isOffline } from "@/lib/safe-call";

const STATUS_TEXT: Record<number, string> = {
  401: "نشست شما منقضی شده است. صفحه را تازه کنید و دوباره با کد پیامکی وارد شوید.",
  403: "نشست شما منقضی شده است. صفحه را تازه کنید و دوباره با کد پیامکی وارد شوید.",
  404: "فایل پیدا نشد. صفحه را تازه کنید.",
  409: "بررسی صحت فایل ناموفق بود؛ لطفاً به پشتیبانی اطلاع دهید.",
  429: "درخواست‌ها زیاد بود؛ چند دقیقه بعد دوباره تلاش کنید.",
};

/**
 * U-09 / U-08 — دکمه‌ی دریافت PDF که در همه‌ی مرورگرها (از جمله مرورگر داخلی تلگرام/اینستاگرام) «بی‌صدا شکست نمی‌خورد».
 *  - مرورگر معمولی: همان لینک ساده (رفتار قبلی)، فقط اگر آفلاین باشد به‌جای صفحه‌ی خطای مرورگر پیام روشن می‌دهد.
 *  - مرورگر داخلی: فایل با fetch (با سقف زمان) گرفته می‌شود؛ اگر برگه‌ی اشتراک‌گذاری دستگاه (Web Share) باشد از آن استفاده می‌شود،
 *    وگرنه دانلود blob. در هر حال یک راهنمای دائمی با «باز کردن در مرورگر»، «کپی لینک» و «مشاهده‌ی PDF» نمایش داده می‌شود.
 */
export default function PdfDownloadButton({ href, filename = "contract.pdf", className, children }: { href: string; filename?: string; className?: string; children?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const [inApp, setInApp] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const aborter = useRef<AbortController | null>(null);

  const absolute = () => new URL(href, window.location.origin).toString();
  const viewHref = withQuery(href, "inline", "1");

  const blobDownload = async () => {
    aborter.current?.abort();
    const ac = new AbortController();
    aborter.current = ac;
    const timer = window.setTimeout(() => ac.abort(), 60_000);
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(href, { credentials: "same-origin", signal: ac.signal });
      if (!res.ok) {
        setMsg({ tone: "error", text: STATUS_TEXT[res.status] ?? NET_MESSAGES.server });
        return;
      }
      const blob = new Blob([await res.arrayBuffer()], { type: "application/pdf" });
      const file = new File([blob], filename, { type: "application/pdf" });
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: filename });
          setMsg({ tone: "ok", text: "فایل آماده شد؛ در برگه‌ی باز‌شده «ذخیره در فایل‌ها» یا برنامه‌ی دلخواه را انتخاب کنید." });
          return;
        } catch (e) {
          if ((e as { name?: string }).name === "AbortError") return; // کاربر برگه را بست
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMsg({ tone: "ok", text: "دانلود آغاز شد. اگر فایلی دریافت نکردید، از راهنمای زیر استفاده کنید." });
    } catch (e) {
      const aborted = (e as { name?: string }).name === "AbortError";
      setMsg({ tone: "error", text: isOffline() ? NET_MESSAGES.offline : aborted ? NET_MESSAGES.timeout : NET_MESSAGES.server });
    } finally {
      window.clearTimeout(timer);
      setBusy(false);
      setHelp(true);
    }
  };

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (isOffline()) {
      e.preventDefault();
      setMsg({ tone: "error", text: NET_MESSAGES.offline });
      return;
    }
    const detected = detectInAppBrowser(navigator.userAgent);
    setInApp(detected);
    if (!detected) return; // مرورگر معمولی: دانلود بومی
    e.preventDefault();
    setHelp(true);
    void blobDownload();
  };

  const openExternal = () => {
    const ua = navigator.userAgent;
    const abs = absolute();
    const intent = isAndroid(ua) ? androidChromeIntent(abs) : null;
    if (intent) window.location.href = intent;
    else window.open(abs, "_blank", "noopener");
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(absolute());
    } catch {
      const ta = document.createElement("textarea");
      ta.value = absolute();
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {}
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div>
      <a href={href} download={filename} onClick={onClick} aria-busy={busy} className={className} data-testid="pdf-download">
        {busy ? <LoaderCircle size={17} className="animate-spin" aria-hidden="true" /> : null}
        {children}
      </a>
      {msg && (
        <p role={msg.tone === "error" ? "alert" : "status"} className={`mt-2 rounded-xl border p-3 text-xs leading-6 ${msg.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
          {msg.text}
        </p>
      )}
      <button type="button" onClick={() => setHelp((v) => !v)} aria-expanded={help} className="mt-2 w-full text-center text-xs font-bold text-ink/75 underline underline-offset-4">
        دانلود شروع نشد؟
      </button>
      {help && (
        <div className="mt-2 space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-7 text-amber-900" data-testid="pdf-help">
          <p>
            {inApp ? <>این صفحه داخل مرورگر «{inApp}» باز شده و ممکن است دانلود فایل را مسدود کند. </> : null}
            برای دریافت مطمئن فایل، یکی از راه‌های زیر را امتحان کنید:
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={openExternal} className="btn-secondary btn-sm"><ExternalLink size={14} />باز کردن در مرورگر</button>
            <a href={viewHref} target="_blank" rel="noopener" className="btn-secondary btn-sm"><Eye size={14} />مشاهده‌ی PDF</a>
            <button type="button" onClick={copy} className="btn-secondary btn-sm"><Copy size={14} />{copied ? "کپی شد ✓" : "کپی لینک"}</button>
          </div>
          <p className="text-[11px] text-amber-800">نکته: در تلگرام/اینستاگرام از منوی سه‌نقطه‌ی بالای صفحه گزینه‌ی «Open in browser / باز کردن در مرورگر» را بزنید.</p>
        </div>
      )}
    </div>
  );
}

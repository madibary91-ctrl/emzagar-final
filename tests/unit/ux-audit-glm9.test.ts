import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import OtpInput from "@/components/OtpInput";
import ExitActions from "@/components/ui/ExitActions";
import SilentBoundary from "@/components/ui/SilentBoundary";
import UploadProgress from "@/components/UploadProgress";
import PdfDownloadButton from "@/components/PdfDownloadButton";
import OfflineBanner from "@/components/OfflineBanner";
import LazyChatWidget from "@/components/chat/LazyChatWidget";
import { PdfPages, PDF_FETCH_TIMEOUT_MS, PDF_ZOOM_STEPS } from "@/components/DocViews";
import { isOtpComplete, normalizeOtp, OTP_MAX_ACCEPT, OTP_PLACEHOLDER } from "@/lib/otp-client";
import { otpDigits, randomOtp } from "@/lib/otp-digits";
import { NET_MESSAGES, runSafely, safeCall, safeCallWith } from "@/lib/safe-call";
import { androidChromeIntent, detectInAppBrowser, isAndroid, withQuery } from "@/lib/inapp-browser";
import { pdfDisposition, wantsInline } from "@/lib/pdf-disposition";
import { uploadForm } from "@/lib/upload-client";

const root = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ───────── U-01…U-05: کد ۶ رقمی ───────── */
describe("U-01…U-05 — ورودی OTP با طول واقعی سرور", () => {
  it("کدی که سرور در production می‌فرستد (۶ رقم) کامل پذیرفته می‌شود", () => {
    const env = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    const code = randomOtp((a, b) => a + Math.floor((b - a) / 2), otpDigits(env));
    expect(code).toHaveLength(6);
    expect(isOtpComplete(normalizeOtp(code))).toBe(true);
  });

  it("normalizeOtp: ارقام فارسی/عربی، فاصله و حروف؛ سقف ۸ رقم؛ رقم ششم حذف نمی‌شود", () => {
    expect(normalizeOtp("۱۲۳ ۴۵۶")).toBe("123456");
    expect(normalizeOtp("١٢٣٤٥٦")).toBe("123456");
    expect(normalizeOtp("12-34-56")).toBe("123456");
    expect(normalizeOtp("1234567890")).toHaveLength(OTP_MAX_ACCEPT);
    expect(OTP_MAX_ACCEPT).toBeGreaterThanOrEqual(8);
  });

  it("isOtpComplete: ۵ تا ۸ رقم (همان قاعده‌ی سرور)", () => {
    expect(isOtpComplete("1234")).toBe(false);
    for (const c of ["12345", "123456", "1234567", "12345678"]) expect(isOtpComplete(c)).toBe(true);
    expect(isOtpComplete("123456789")).toBe(false);
    expect(isOtpComplete("12345a")).toBe(false);
  });

  it("OtpInput: بدون maxLength، ارقام فارسی، placeholder شش‌نقطه‌ای، autocomplete=one-time-code", () => {
    const html = renderToStaticMarkup(createElement(OtpInput, { id: "x", value: "123456", onChange: () => {} }));
    expect(html).toContain("۱۲۳۴۵۶");
    expect(html).not.toContain("maxLength");
    expect(html).not.toContain("maxlength");
    expect(html).toContain(`placeholder="${OTP_PLACEHOLDER}"`);
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('enterKeyHint="done"');
  });

  const OTP_FILES = [
    "src/components/GuestSign.tsx",
    "src/components/vault/VaultLogin.tsx",
    "src/components/vault/VaultSignCta.tsx",
    "src/components/SignPanel.tsx",
    "src/components/AmendmentDecision.tsx",
  ];
  it.each(OTP_FILES)("%s: هیچ سقف/شرط ۵ رقمی ثابت نمانده و از OtpInput مشترک استفاده می‌کند", (f) => {
    const src = read(f);
    expect(src).not.toMatch(/slice\(0,\s*5\)/);
    expect(src).not.toMatch(/length\s*!==\s*5/);
    expect(src).not.toContain('• • • • •"');
    expect(src).toContain("<OtpInput");
    expect(src).toContain("isOtpComplete");
  });
});

/* ───────── U-06: safeCall ───────── */
describe("U-06 — safeCall هرگز نمی‌اندازد", () => {
  type R = { ok: boolean; error?: string; offline?: boolean; timeout?: boolean };

  it("موفقیت: نتیجه‌ی اکشن عیناً برمی‌گردد", async () => {
    await expect(safeCall(async () => ({ ok: true as const, n: 1 }))).resolves.toEqual({ ok: true, n: 1 });
  });

  it("خطای شبکه (آنلاین): پیام «سرور» و ok=false", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const r = await safeCall<R>(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(r).toMatchObject({ ok: false, error: NET_MESSAGES.server, offline: false });
  });

  it("آفلاین: پیام قطعی اینترنت", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const r = await safeCall<R>(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(r).toMatchObject({ ok: false, error: NET_MESSAGES.offline, offline: true });
  });

  it("تایم‌اوت: اکشن معلق هم دکمه را برای همیشه گیر نمی‌اندازد", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const r = await safeCall<R>(() => new Promise(() => {}), { timeoutMs: 15 });
    expect(r).toMatchObject({ ok: false, error: NET_MESSAGES.timeout, timeout: true });
  });

  it("redirect/notFound ریشه‌ی Next بلعیده نمی‌شود", async () => {
    const err = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/x;307;" });
    await expect(safeCall(() => Promise.reject(err))).rejects.toBe(err);
  });

  it("safeCallWith: شکل خطای دلخواه (آرایه، {level,message} …)", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const r = await safeCallWith<{ level: string; message: string }>(
      () => Promise.reject(new Error("x")),
      (message) => ({ level: "error", message }),
    );
    expect(r).toEqual({ level: "error", message: NET_MESSAGES.offline });
    expect(await runSafely(() => Promise.reject(new Error("x")))).toBe(NET_MESSAGES.offline);
    expect(await runSafely(async () => 1)).toBeNull();
  });

  it("هیچ کامپوننتی Server Action را بدون safeCall صدا نمی‌زند (پیشگیری از بازگشت باگ)", () => {
    const offenders: string[] = [];
    for (const f of walk("src/components")) {
      read(f)
        .split("\n")
        .forEach((line, i) => {
          if (/await\s+[A-Za-z0-9_]+Action\(/.test(line) && !line.includes(".catch(")) offenders.push(`${f}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

/* ───────── U-07: ویجت گفتگو ───────── */
describe("U-07 — ویجت گفتگو صفحه را نمی‌اندازد", () => {
  it("بدون next/dynamic؛ با import دستی، catch و مرز خطای ساکت", () => {
    const src = read("src/components/chat/LazyChatWidget.tsx");
    expect(src).not.toMatch(/from\s+["']next\/dynamic["']/);
    expect(src).toContain('import("./ChatWidget")');
    expect(src).toContain(".catch(");
    expect(src).toContain("SilentBoundary");
    expect(src).toContain('"online"');
  });

  it("رندر اولیه (قبل از بارگذاری) هیچ‌چیز نمی‌دهد", () => {
    expect(renderToStaticMarkup(createElement(LazyChatWidget, { context: { kind: "sign", ref: "t" } as never }))).toBe("");
  });

  it("SilentBoundary: خطای رندر فرزند → fallback (null)، نه سقوط", () => {
    expect(SilentBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const b = new SilentBoundary({ children: "child" });
    expect(b.render()).toBe("child");
    b.state = { failed: true };
    expect(b.render()).toBeNull();
  });
});

/* ───────── U-08 / U-11 / U-15: DocViews و آفلاین ───────── */
describe("U-08/U-11/U-15 — واکشی PDF، آفلاین و زوم", () => {
  it("سقف زمان واکشی و گام‌های زوم تعریف شده‌اند", () => {
    expect(PDF_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PDF_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    expect(PDF_ZOOM_STEPS[0]).toBe(1);
    expect(PDF_ZOOM_STEPS.at(-1)).toBeGreaterThanOrEqual(2);
  });

  it("PdfPages بدون سند هنوز اسکلت صفحه‌ها را نشان می‌دهد و نوار زوم فقط پس از بارگذاری می‌آید", () => {
    const html = renderToStaticMarkup(createElement(PdfPages, { url: "/x.pdf", pages: [{ w: 595, h: 842 }, { w: 595, h: 842 }] as never }));
    expect(html).toContain('data-page="0"');
    expect(html).toContain('data-page="1"');
    expect(html).not.toContain("بزرگ‌نمایی");
  });

  it("منبع: AbortController + رویداد online + پیام‌های آفلاین/تایم‌اوت + دکمه‌های زوم", () => {
    const src = read("src/components/DocViews.tsx");
    expect(src).toContain("AbortController");
    expect(src).toContain('"online"');
    expect(src).toContain("PDF_ERRORS");
    expect(src).toContain('aria-label="بزرگ‌نمایی"');
  });

  it("OfflineBanner: در حالت آنلاین چیزی رندر نمی‌کند و در layout نصب است", () => {
    expect(renderToStaticMarkup(createElement(OfflineBanner))).toBe("");
    expect(read("src/app/layout.tsx")).toContain("<OfflineBanner />");
  });
});

/* ───────── U-09: دانلود PDF در مرورگر داخلی ───────── */
describe("U-09 — دانلود PDF در مرورگر داخلی تلگرام/اینستاگرام", () => {
  const UA = {
    tgAndroid: "Mozilla/5.0 (Linux; Android 13; SM-S908B Build/TP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 Telegram-Android/10.0",
    tgIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Telegram",
    insta: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21A329 Instagram 300.0.0.0",
    androidWv: "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/SD1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0 Mobile Safari/537.36",
    iosWebview: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    chrome: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
    safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    eitaa: "Mozilla/5.0 (Linux; Android 11) Eitaa/1.0",
  };

  it("مرورگرهای داخلی تشخیص داده می‌شوند و مرورگرهای معمولی نه", () => {
    expect(detectInAppBrowser(UA.tgAndroid)).toBe("تلگرام");
    expect(detectInAppBrowser(UA.tgIos)).toBe("تلگرام");
    expect(detectInAppBrowser(UA.insta)).toBe("اینستاگرام");
    expect(detectInAppBrowser(UA.eitaa)).toBe("ایتا");
    expect(detectInAppBrowser(UA.androidWv)).toBe("مرورگر داخلی");
    expect(detectInAppBrowser(UA.iosWebview)).toBe("مرورگر داخلی");
    for (const ua of [UA.chrome, UA.safari, UA.desktop]) expect(detectInAppBrowser(ua)).toBeNull();
  });

  it("لینک intent اندروید و withQuery", () => {
    expect(isAndroid(UA.tgAndroid)).toBe(true);
    expect(androidChromeIntent("https://sign.example.com/api/sign/abc/pdf?x=1")).toBe("intent://sign.example.com/api/sign/abc/pdf?x=1#Intent;scheme=https;package=com.android.chrome;end");
    expect(androidChromeIntent("javascript:alert(1)")).toBeNull();
    expect(withQuery("/api/a/pdf", "inline", "1")).toBe("/api/a/pdf?inline=1");
    expect(withQuery("/api/a/pdf?k=2", "inline", "1")).toBe("/api/a/pdf?k=2&inline=1");
  });

  it("?inline=1 ⇒ Content-Disposition درون‌خطی؛ بدون آن دانلود", () => {
    expect(wantsInline("https://x.test/api/sign/t/pdf?inline=1")).toBe(true);
    expect(wantsInline("https://x.test/api/sign/t/pdf")).toBe(false);
    expect(pdfDisposition("https://x.test/p?inline=1", "a.pdf")).toBe('inline; filename="a.pdf"');
    expect(pdfDisposition("https://x.test/p", "a.pdf")).toBe('attachment; filename="a.pdf"');
  });

  it("مسیرهای PDF مهمان/کیف/رسید از inline پشتیبانی می‌کنند و صفحه‌ها از PdfDownloadButton استفاده می‌کنند", () => {
    expect(read("src/app/api/sign/[token]/pdf/route.ts")).toContain("pdfDisposition(req.url");
    expect(read("src/app/api/vault/contracts/[id]/pdf/route.ts")).toContain("pdfDisposition(req.url");
    expect(read("src/app/api/collect/receipt/[receipt]/pdf/route.ts")).toContain("wantsInline(req.url)");
    expect(read("src/app/sign/[token]/page.tsx")).toContain("<PdfDownloadButton");
    expect(read("src/components/vault/VaultDashboard.tsx")).toContain("<PdfDownloadButton");
  });

  it("PdfDownloadButton: لینک معمولی + راهنمای «دانلود شروع نشد؟»", () => {
    const html = renderToStaticMarkup(createElement(PdfDownloadButton, { href: "/api/sign/t/pdf", filename: "c.pdf", className: "btn" }, "دریافت"));
    expect(html).toContain('href="/api/sign/t/pdf"');
    expect(html).toContain('data-testid="pdf-download"');
    expect(html).toContain("دانلود شروع نشد؟");
  });
});

/* ───────── U-10: لینک کوتاه پیش‌نویس ───────── */
describe("U-10 — لینک کوتاه قرارداد پیش‌نویس", () => {
  it("مهمان کارت توضیحی می‌بیند، نه پرتاب بی‌توضیح به /login", () => {
    const src = read("src/app/s/[code]/page.tsx");
    expect(src).toContain("draft-link-card");
    expect(src).toContain("هنوز برای امضا ارسال نشده");
    expect(src).not.toMatch(/c\.status === "draft"\)\s*redirect\("\/login"\)/);
    expect(src).not.toMatch(/!c \|\| c\.status === "draft"/);
  });
});

/* ───────── U-12 / U-13: آپلود ───────── */
describe("U-12/U-13 — آپلود با پیشرفت، تایم‌اوت و بدون گیر", () => {
  class FakeXhr {
    static last: FakeXhr;
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    responseText = "";
    timeout = 0;
    withCredentials = false;
    responseType = "";
    constructor() {
      FakeXhr.last = this;
    }
    open() {}
    abort() {
      this.onabort?.();
    }
    send() {}
  }

  it("آفلاین: بدون ارسال، بلافاصله پیام روشن", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const r = await uploadForm("/u", new FormData());
    expect(r).toMatchObject({ ok: false, kind: "offline", error: NET_MESSAGES.offline });
  });

  it("پیشرفت گزارش می‌شود و پاسخ موفق parse می‌شود", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const seen: Array<number | null> = [];
    const p = uploadForm<{ id: number }>("/u", new FormData(), { onProgress: (n) => seen.push(n) });
    const x = FakeXhr.last;
    x.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 200 });
    x.status = 200;
    x.responseText = JSON.stringify({ ok: true, id: 7 });
    x.onload?.();
    await expect(p).resolves.toMatchObject({ ok: true, data: { id: 7 } });
    expect(seen[0]).toBe(25);
    expect(seen.at(-1)).toBe(100);
  });

  it("خطای سرور، تایم‌اوت، قطع شبکه و لغو هر کدام نتیجه‌ی ok=false می‌دهند (هرگز نمی‌اندازند)", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    let p = uploadForm("/u", new FormData());
    FakeXhr.last.status = 413;
    FakeXhr.last.responseText = JSON.stringify({ ok: false, error: "حجم زیاد است" });
    FakeXhr.last.onload?.();
    await expect(p).resolves.toMatchObject({ ok: false, kind: "http", status: 413, error: "حجم زیاد است" });

    p = uploadForm("/u", new FormData());
    FakeXhr.last.ontimeout?.();
    await expect(p).resolves.toMatchObject({ ok: false, kind: "timeout" });

    p = uploadForm("/u", new FormData());
    FakeXhr.last.onerror?.();
    await expect(p).resolves.toMatchObject({ ok: false, kind: "network" });

    const ac = new AbortController();
    p = uploadForm("/u", new FormData(), { signal: ac.signal });
    ac.abort();
    await expect(p).resolves.toMatchObject({ ok: false, kind: "aborted" });
  });

  it("UploadProgress نقش progressbar و درصد دارد", () => {
    const html = renderToStaticMarkup(createElement(UploadProgress, { percent: 42, onCancel: () => {} }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain("لغو");
  });

  it("پیوست و مدارک هویت از uploadForm استفاده می‌کنند (نه fetch بی‌پیشرفت)", () => {
    for (const f of ["src/components/AttachmentsPanel.tsx", "src/components/DocUploader.tsx", "src/components/identity/SignerIdentityGate.tsx"]) {
      expect(read(f)).toContain("uploadForm");
      expect(read(f)).toContain("UploadProgress");
    }
  });
});

/* ───────── U-14 / U-17 / U-18 / U-19: بن‌بست‌ها و موبایل ───────── */
describe("U-14…U-19 — بن‌بست‌های موبایل", () => {
  it("ExitActions: تازه‌سازی، بازگشت، صفحه‌ی اصلی", () => {
    const html = renderToStaticMarkup(createElement(ExitActions, {}));
    expect(html).toContain("تازه‌سازی صفحه");
    expect(html).toContain("بازگشت");
    expect(html).toContain("صفحه‌ی اصلی");
  });

  it("کارت‌های وضعیت صفحه‌ی امضا (نامعتبر/منقضی/لغو) خروجی دارند", () => {
    const src = read("src/app/sign/[token]/page.tsx");
    expect(src).toContain("<ExitActions");
    expect(src).toMatch(/tone !== "emerald" && <ExitActions/);
  });

  it("مرز خطای سراسری: بازگشت + آفلاین + تلاش خودکار با online", () => {
    const src = read("src/app/error.tsx");
    expect(src).toContain("بازگشت");
    expect(src).toContain("useOnline");
    expect(src).toContain('"online"');
    expect(read("src/app/global-error.tsx")).toContain("تازه‌سازی صفحه");
  });

  it("viewport کیبورد موبایل (بدون قفل زوم) و هدف لمسی ۴۴ پیکسل", () => {
    expect(read("src/app/layout.tsx")).toContain('interactiveWidget: "resizes-content"');
    expect(read("src/app/layout.tsx")).not.toMatch(/userScalable|maximumScale/);
    expect(read("src/app/globals.css")).toMatch(/\.btn-sm \{ min-height: 44px !important; \}/);
  });
});

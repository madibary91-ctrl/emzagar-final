import { NextResponse } from "next/server";

/** پاسخ PDF امن (بدون کش، بدون ارجاع) برای نمایش درون‌خطی در ویرایشگر/امضا یا دانلود */
export function fileResponse(buf: Buffer, opts: { filename: string; inline?: boolean; mime?: string; viewer?: boolean }) {
  const safe = opts.filename.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "document";
  // viewer=true: نمایش مستقیم در مرورگر (مثلاً مرورگر داخلی تلگرام)؛ CSP «sandbox» نمایشگر PDF مرورگر را می‌شکند، پس فقط همان یک هدر حذف می‌شود
  const csp: Record<string, string> = opts.viewer ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'" };
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": opts.mime ?? "application/pdf",
      "Content-Disposition": `${opts.inline ? "inline" : "attachment"}; filename="${safe}"`,
      "Content-Length": String(buf.length),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...csp,
    },
  });
}

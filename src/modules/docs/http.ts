import { NextResponse } from "next/server";

/** پاسخ PDF امن (بدون کش، بدون ارجاع) برای نمایش درون‌خطی در ویرایشگر/امضا یا دانلود */
export function fileResponse(buf: Buffer, opts: { filename: string; inline?: boolean; mime?: string }) {
  const safe = opts.filename.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "document";
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": opts.mime ?? "application/pdf",
      "Content-Disposition": `${opts.inline ? "inline" : "attachment"}; filename="${safe}"`,
      "Content-Length": String(buf.length),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}

"use client";

import { usePathname } from "next/navigation";
import ChatWidget from "./ChatWidget";

/** صفحه‌هایی که خودشان کنسول گفتگو هستند: ویجت شناور آنجا نمایش داده نمی‌شود */
const HIDDEN_PREFIXES = ["/platform/chat", "/admin/chat"];

/**
 * ویجت گفتگوی کاربر واردشده در پنل. قرارداد جاری را از روی آدرس تشخیص می‌دهد
 * (فقط راهنمای زمینه است؛ سرور دسترسی کاربر به آن قرارداد را دوباره راستی‌آزمایی می‌کند).
 */
export default function PanelChatWidget() {
  const pathname = usePathname() || "";
  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null;
  const m = /^\/(?:admin\/)?contracts\/(\d+)(?:\/|$)/.exec(pathname);
  return <ChatWidget context={{ kind: "panel", contractId: m ? Number(m[1]) : undefined }} />;
}

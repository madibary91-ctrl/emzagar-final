"use client";
import { type GlobalGroup, SECTION_DEFS, type Section } from "@/modules/landing/schema";
import { Megaphone, Menu as MenuIcon, Palette, PanelBottom, Search } from "lucide-react";

export type Device = "desktop" | "tablet" | "mobile";
export type SaveState = "saved" | "dirty" | "saving" | "error";
export const DEVICE_W: Record<Device, string> = { desktop: "100%", tablet: "820px", mobile: "390px" };
export const GROUPS: { id: GlobalGroup; label: string; caption: string; icon: typeof Palette }[] = [
  { id: "theme", label: "برند و رنگ‌ها", caption: "نام، لوگو، رنگ، حالت روشن/تیره", icon: Palette },
  { id: "nav", label: "منوی بالای صفحه", caption: "لینک‌ها و دکمه‌ی منو", icon: MenuIcon },
  { id: "announcement", label: "نوار اطلاع‌رسانی", caption: "پیام کوتاه بالای سایت", icon: Megaphone },
  { id: "footer", label: "پایین صفحه (فوتر)", caption: "معرفی، لینک‌ها، کپی‌رایت", icon: PanelBottom },
  { id: "seo", label: "سئو و پیش‌نمایش گوگل", caption: "عنوان، توضیح، تصویر اشتراک", icon: Search },
];
export const sectionTitle = (s: Section) => {
  const p = s.props;
  for (const k of ["heading", "title", "badge", "body"]) if (typeof p[k] === "string" && p[k]) return String(p[k]).slice(0, 48);
  return SECTION_DEFS[s.type].description;
};

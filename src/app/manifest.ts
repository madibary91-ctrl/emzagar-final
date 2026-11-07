import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "امضاگیر — امضای آنلاین قرارداد",
    short_name: "امضاگیر",
    description: "صدور، امضا و مدیریت قراردادهای دیجیتال با احراز هویت پیامکی",
    lang: "fa",
    dir: "rtl",
    start_url: "/login",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f4f3ed",
    theme_color: "#102c31",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "صدور قرارداد", url: "/admin/new", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "قراردادهای من", url: "/dashboard", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "تحلیل ریسک", url: "/admin/risk", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}

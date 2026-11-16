import { ImageResponse } from "next/og";

export const alt = "Emzagar — Online contract signing";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** تصویر پیش‌فرض اشتراک‌گذاری (OG). متن لاتین است چون موتور رندر تصویر شکل‌دهی حروف فارسی را پشتیبانی نمی‌کند. */
export default function OgImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: 80, background: "linear-gradient(135deg,#102c31 0%,#1d3d40 60%,#41e4ad 160%)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div style={{ width: 96, height: 96, borderRadius: 28, background: "#41e4ad", display: "flex", alignItems: "center", justifyContent: "center", color: "#102c31", fontSize: 64, fontWeight: 900 }}>E</div>
          <div style={{ fontSize: 84, fontWeight: 900, letterSpacing: -2 }}>Emzagar</div>
        </div>
        <div style={{ marginTop: 40, fontSize: 44, color: "#d7f7ec" }}>Legally binding online contract signing</div>
        <div style={{ marginTop: 24, fontSize: 30, color: "#9fd8c6" }}>SMS verification · Digital fingerprint · PDF & QR verify</div>
      </div>
    ),
    size,
  );
}

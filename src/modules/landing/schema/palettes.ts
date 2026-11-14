/* ───────── رنگ ───────── */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
export const PALETTES: { id: string; name: string; primary: string; accent: string; mode: string }[] = [
  { id: "teal", name: "فیروزه‌ای شب", primary: "#102c31", accent: "#41e4ad", mode: "light" },
  { id: "ocean", name: "اقیانوس", primary: "#0b2a4a", accent: "#4cc9f0", mode: "light" },
  { id: "violet", name: "بنفش مدرن", primary: "#271a4f", accent: "#b794f6", mode: "light" },
  { id: "coral", name: "مرجان گرم", primary: "#3a1f1d", accent: "#ff8a6b", mode: "light" },
  { id: "forest", name: "جنگل", primary: "#123524", accent: "#86efac", mode: "light" },
  { id: "midnight", name: "نیمه‌شب (تیره)", primary: "#0f172a", accent: "#38bdf8", mode: "dark" },
  { id: "minimal", name: "مینیمال ایندیگو", primary: "#1e1b4b", accent: "#818cf8", mode: "light" },
];

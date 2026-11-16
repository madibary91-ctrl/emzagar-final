/** علامت‌گذاری نتیجه‌ی جستجوی متن کامل (بدون HTML خام): ⟦واژه‌ی یافت‌شده⟧ */
export const HL_START = "⟦";
export const HL_STOP = "⟧";

/** تقسیم قطعه به بخش‌های «معمولی/برجسته» برای رندر امن در React (<mark>) */
export function splitHighlight(snippet: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let rest = snippet;
  while (rest) {
    const a = rest.indexOf(HL_START);
    if (a < 0) {
      parts.push({ text: rest, hit: false });
      break;
    }
    if (a > 0) parts.push({ text: rest.slice(0, a), hit: false });
    const b = rest.indexOf(HL_STOP, a + 1);
    if (b < 0) {
      parts.push({ text: rest.slice(a + 1), hit: false });
      break;
    }
    parts.push({ text: rest.slice(a + 1, b), hit: true });
    rest = rest.slice(b + 1);
  }
  return parts;
}

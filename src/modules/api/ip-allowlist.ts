import net from "node:net";

/** فهرست مجاز IP کلید API (سمت سرور؛ جدا از scopes.ts تا کامپوننت‌های کلاینت `node:net` نکشند) */
/* ───────── فهرست مجاز IP (IPv4/IPv6، تک‌آدرس یا CIDR) ───────── */

/** نتیجه‌ی تجزیه: فهرست معتبر + ورودی‌های نامعتبر (برای پیام خطا در فرم) */
export function parseIpAllowlist(csv: string | null | undefined): { entries: string[]; invalid: string[] } {
  const entries: string[] = [];
  const invalid: string[] = [];
  for (const raw of String(csv ?? "").split(/[,\s،]+/)) {
    const t = raw.trim();
    if (!t) continue;
    const [addr, bits] = t.split("/");
    const kind = net.isIP(addr);
    const max = kind === 4 ? 32 : 128;
    const okBits = bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) >= 0 && Number(bits) <= max);
    if (kind === 0 || !okBits) invalid.push(t);
    else entries.push(t);
  }
  return { entries: entries.slice(0, 20), invalid };
}

/** آیا IP در فهرست مجاز است؟ فهرست خالی = بدون محدودیت. IP نامعلوم همیشه رد می‌شود وقتی فهرست دارد (fail-closed). */
export function ipAllowed(allowlistCsv: string, ip: string): boolean {
  const { entries } = parseIpAllowlist(allowlistCsv);
  if (entries.length === 0) return true;
  const clean = ip.replace(/^::ffff:(?=\d)/i, "");
  const kind = net.isIP(clean);
  if (kind === 0) return false;
  const list = new net.BlockList();
  for (const e of entries) {
    const [addr, bits] = e.split("/");
    const k = net.isIP(addr) === 4 ? "ipv4" : "ipv6";
    if (bits === undefined) list.addAddress(addr, k);
    else list.addSubnet(addr, Number(bits), k);
  }
  return list.check(clean, kind === 4 ? "ipv4" : "ipv6");
}

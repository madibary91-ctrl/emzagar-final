import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseByteRange, ifRangeAllows } from "@/lib/http-range";

const ROOT = process.cwd();

describe("یکپارچگی بسته‌ی تحویلی (خریدار باید بتواند از رجیستری رسمی نصب کند)", () => {
  const lockPath = path.join(ROOT, "package-lock.json");

  it("package-lock.json (اگر هست) فقط به رجیستری رسمی npm اشاره می‌کند و همه‌ی بسته‌ها integrity دارند", () => {
    if (!fs.existsSync(lockPath)) return; // Dockerfile بدون قفل‌فایل هم `npm install` می‌کند؛ نبودنش خطا نیست
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { packages?: Record<string, { resolved?: string; integrity?: string; link?: boolean }> };
    const bad: string[] = [];
    let n = 0;
    for (const [name, p] of Object.entries(lock.packages ?? {})) {
      if (!name || p.link || !p.resolved) continue;
      n++;
      if (!p.resolved.startsWith("https://registry.npmjs.org/")) bad.push(`${name} → ${p.resolved}`);
      if (!p.integrity) bad.push(`${name} بدون integrity`);
    }
    expect(n).toBeGreaterThan(0);
    expect(bad, bad.slice(0, 5).join("\n")).toEqual([]);
    // هیچ رجیستری میرور/خصوصی یا http ساده‌ای در متن فایل نباشد
    const raw = fs.readFileSync(lockPath, "utf8");
    expect(raw).not.toMatch(/"resolved":\s*"(?!https:\/\/registry\.npmjs\.org\/)/);
    expect(raw).not.toMatch(/"resolved":\s*"http:\/\//);
  });

  it(".npmrc پروژه رجیستری دیگری تحمیل نمی‌کند", () => {
    const f = path.join(ROOT, ".npmrc");
    if (!fs.existsSync(f)) return;
    const txt = fs.readFileSync(f, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      if (/^\s*(@[\w-]+:)?registry\s*=/.test(line)) expect(line).toMatch(/registry\.npmjs\.org/);
    }
  });

  it("قلم‌های PDF (Vazirmatn) در مخزن هستند و فایل TrueType واقعی‌اند (بدون آن‌ها هیچ PDF/نسخه‌ی نهایی مهمان ساخته نمی‌شود)", () => {
    for (const f of ["Vazirmatn-Regular.ttf", "Vazirmatn-Bold.ttf"]) {
      const p = path.join(ROOT, "assets", "fonts", f);
      expect(fs.existsSync(p), f).toBe(true);
      const buf = fs.readFileSync(p);
      expect(buf.length, f).toBeGreaterThan(50_000);
      const magic = buf.subarray(0, 4).toString("hex");
      expect(["00010000", "4f54544f", "74727565"], f).toContain(magic);
    }
  });
});

describe("ادامه‌ی دانلود PDF (HTTP Range)", () => {
  it("بازه‌های معتبر، پسوندی، بیرون از محدوده و نامعتبر", () => {
    expect(parseByteRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseByteRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=5-2", 1000)).toBeNull();
    expect(parseByteRange("bytes=0-1,5-9", 1000)).toBeNull();
    expect(parseByteRange("items=0-1", 1000)).toBeNull();
    expect(parseByteRange(null, 1000)).toBeNull();
  });

  it("If-Range فقط با ETag یکسان بازه را فعال نگه می‌دارد", () => {
    expect(ifRangeAllows(undefined, '"a"')).toBe(true);
    expect(ifRangeAllows('"a"', '"a"')).toBe(true);
    expect(ifRangeAllows('"b"', '"a"')).toBe(false);
  });
});

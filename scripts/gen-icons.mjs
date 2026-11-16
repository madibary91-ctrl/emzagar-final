#!/usr/bin/env node
/**
 * ساخت آیکون‌های PWA/سئو (public/icons/*.png) از یک SVG برند، با Chromium مجموعه‌ی Playwright (بدون وابستگی جدید).
 *   node scripts/gen-icons.mjs
 * خروجی: icon-192.png · icon-512.png · maskable-512.png (ناحیه‌ی امن ۸۰٪) · apple-touch-icon.png (۱۸۰)
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BG = "#102c31";
const FG = "#2dd4a0";

/** نشانک برند: موج «امضا» روی زمینه‌ی سبز تیره. scale: اندازه‌ی نشانک نسبت به بوم. */
const svg = (size, { radius, scale }) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${radius}" fill="${BG}"/>
  <g transform="translate(50 50) scale(${scale}) translate(-50 -50)">
    <path d="M14 62 C 24 62, 26 38, 36 38 S 48 66, 58 56 S 70 34, 86 40" fill="none" stroke="${FG}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M18 78 H82" fill="none" stroke="${FG}" stroke-opacity=".45" stroke-width="5" stroke-linecap="round"/>
  </g>
</svg>`;

const TARGETS = [
  { file: "icon-192.png", size: 192, radius: 22, scale: 1 },
  { file: "icon-512.png", size: 512, radius: 22, scale: 1 },
  { file: "maskable-512.png", size: 512, radius: 0, scale: 0.72 },
  { file: "apple-touch-icon.png", size: 180, radius: 0, scale: 0.86 },
];

const out = path.resolve("public/icons");
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const t of TARGETS) {
    const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg(t.size, t)}`);
    await page.screenshot({ path: path.join(out, t.file), omitBackground: true, clip: { x: 0, y: 0, width: t.size, height: t.size } });
    await page.close();
    console.log("✓", t.file);
  }
} finally {
  await browser.close();
}

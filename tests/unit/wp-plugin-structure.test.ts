import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = path.join(process.cwd(), "wordpress-plugin", "emzagar-contracts");
const read = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8");

describe("ساختار افزونه‌ی وردپرس (مرکز فرماندهی کامل)", () => {
  const main = read("emzagar-contracts.php");

  it("همه‌ی فایل‌های require_once وجود دارند", () => {
    const files = [...main.matchAll(/require_once EMZ_DIR \. '([^']+)'/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(fs.existsSync(path.join(DIR, f)), f).toBe(true);
  });

  it("نسخه‌ی هدر و ثابت یکی است و ماژول‌های جدید بوت می‌شوند", () => {
    const header = /Version:\s+(\d+\.\d+\.\d+)/.exec(main)?.[1];
    const constant = /define\( 'EMZ_VERSION', '([^']+)' \)/.exec(main)?.[1];
    expect(header).toBe(constant);
    for (const c of ["Emzagar_Inbox", "Emzagar_Workspace", "Emzagar_Palette", "Emzagar_Automations", "Emzagar_Forms"]) {
      expect(main).toContain(`${c}::init();`);
    }
  });

  it("دارایی‌های جاوااسکریپت و CSS هر ماژول موجودند", () => {
    for (const f of ["assets/js/workspace.js", "assets/js/palette.js", "assets/js/inbox.js", "assets/js/automations.js", "assets/css/workspace.css", "assets/css/inbox.css"]) {
      expect(fs.existsSync(path.join(DIR, f)), f).toBe(true);
    }
  });

  it("رابط‌های جاوااسکریپت از innerHTML استفاده نمی‌کنند (ضد XSS)", () => {
    for (const f of ["workspace.js", "palette.js", "inbox.js", "automations.js"]) {
      expect(read(`assets/js/${f}`), f).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    }
  });

  it("همه‌ی AJAX/admin-post های جدید nonce و سطح دسترسی دارند", () => {
    const ws = read("includes/class-emzagar-workspace.php");
    expect(ws).toContain("check_ajax_referer( 'emzagar_ws', 'nonce' )");
    expect(ws).toContain("check_admin_referer( 'emzagar_ws_pdf' )");
    expect(read("includes/class-emzagar-palette.php")).toContain("check_ajax_referer( 'emzagar_palette', 'nonce' )");
    expect(read("includes/class-emzagar-automations.php")).toContain("check_admin_referer( $nonce )");
    expect(read("includes/class-emzagar-forms.php")).toContain("check_admin_referer( $nonce )");
    expect(read("includes/class-emzagar-automations.php")).toContain("wp_safe_remote_post");
  });

  it("پاک‌سازی هنگام حذف افزونه گزینه‌های جدید را هم پاک می‌کند", () => {
    const u = read("uninstall.php");
    for (const o of ["emzagar_feed", "emzagar_auto_rules", "emzagar_auto_log", "emzagar_form_rules", "emzagar_actions"]) expect(u).toContain(o);
  });
});

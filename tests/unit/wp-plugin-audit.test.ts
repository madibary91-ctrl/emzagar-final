import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * ممیزی افزونه‌ی وردپرس (فاز ۲۹): رفتار واقعی کد PHP در سناریوهای قطعی ابر، هم‌زمانی، امنیت و ووکامرس.
 * اگر PHP نصب نباشد، بخش اجرا رد می‌شود (مثل wp-release.test.ts) ولی بررسی‌های ساختاری همیشه اجرا می‌شوند.
 */
const ROOT = process.cwd();
const PLUGIN = path.join(ROOT, "wordpress-plugin", "emzagar-contracts");
const read = (f: string) => fs.readFileSync(path.join(PLUGIN, f), "utf8");

const PHP = process.env.PHP_BIN || "php";
const probe = spawnSync(PHP, ["-r", 'echo PHP_VERSION_ID >= 70400 ? "1" : "0";'], { encoding: "utf8", env: process.env });
const phpReady = probe.status === 0 && probe.stdout.trim() === "1";

describe.skipIf(!phpReady)("افزونه‌ی وردپرس — اجرای واقعی کد PHP (tests/php/audit.php)", () => {
  const run = spawnSync(PHP, [path.join(ROOT, "tests/php/audit.php")], { encoding: "utf8", env: process.env, timeout: 60_000 });
  const lines = (run.stdout || "").split("\n");

  it("اسکریپت بدون خطای مرگبار تمام می‌شود", () => {
    expect(run.stderr || "").toBe("");
    expect(lines.some((l) => l.startsWith("TOTAL FAIL:"))).toBe(true);
  });

  it("هیچ سناریویی FAIL نمی‌دهد و دست‌کم ۶۰ بررسی اجرا شده است", () => {
    const failed = lines.filter((l) => l.startsWith("FAIL"));
    expect(failed).toEqual([]);
    expect(lines.filter((l) => l.startsWith("PASS")).length).toBeGreaterThanOrEqual(60);
    expect(lines).toContain("TOTAL FAIL: 0");
  });

  it("آزمون‌های PHP قدیمی (run.php) همچنان سبزند", () => {
    const old = spawnSync(PHP, [path.join(ROOT, "tests/php/run.php")], { encoding: "utf8", env: process.env, timeout: 60_000 });
    expect(old.stdout).toContain("TOTAL FAIL: 0");
  });
});

describe("افزونه‌ی وردپرس — پادمان‌های ساختاری ممیزی", () => {
  it("کلید API هرگز روی HTTP ساده فرستاده نمی‌شود و ابر قطع‌شده، درخواست را معطل نمی‌کند", () => {
    const api = read("includes/class-emzagar-api.php");
    expect(api).toContain("transport_ok(");
    expect(api).toContain("emzagar_insecure");
    expect(api).toContain("breaker_open()");
    // قطع‌کننده‌ی مدار نباید با پاک‌سازی کش پاک شود (پیشوند emz_ ← flush_cache)
    expect(api).toMatch(/const BREAKER = 'emzagar_cloud_down'/);
  });

  it("فرم درخواست قرارداد: nonce به شناسه‌ی قالب گره خورده (ضد دست‌کاری template_id)", () => {
    const sc = read("includes/class-emzagar-shortcodes.php");
    expect(sc).toContain("'emzagar_request_' . (int) $tpl");
    expect(sc).not.toMatch(/wp_verify_nonce\([^;]*'emzagar_request'\s*\)/);
    expect(read("includes/class-emzagar-access.php")).toContain("wp_create_nonce( 'emzagar_request_' . (int) $req )");
  });

  it("SSO فقط به همان مبدأ ابر هدایت می‌شود (نه فقط همان میزبان)", () => {
    const c = read("includes/class-emzagar-connect.php");
    expect(c).toContain("self::same_origin( $url, $base )");
    expect(c).not.toMatch(/PHP_URL_HOST \) === wp_parse_url\( \$base/);
  });

  it("صف همگام‌سازی: خطای کل ارتباط از سهمیه‌ی تلاش رویداد کم نمی‌کند", () => {
    const s = read("includes/class-emzagar-sync.php");
    expect(s).toContain("function global_failure(");
    expect(s).toContain("flush_block_until");
    expect(s).toContain("INSERT IGNORE INTO");
    expect(s).toContain("lock_acquire( 'apply'");
  });

  it("نسخه‌ی افزونه، readme و تغییرات هم‌خوان‌اند", () => {
    const main = read("emzagar-contracts.php");
    const v = /Version:\s+(\d+\.\d+\.\d+)/.exec(main)?.[1];
    expect(v).toBe(/define\( 'EMZ_VERSION', '([^']+)' \)/.exec(main)?.[1]);
    expect(read("readme.txt")).toContain(`Stable tag: ${v}`);
    expect(read("readme.txt")).toContain(`= ${v} =`);
  });

  it("حذف افزونه کرون‌های دارای آرگومان و گزینه‌های جدید را پاک می‌کند", () => {
    const u = read("uninstall.php");
    for (const k of ["emzagar_issue_retry", "wp_unschedule_hook", "emzagar_cloud_down", "emzagar_cache_gen", "emzagar\\\\_lock\\\\_"]) {
      expect(u, k).toContain(k);
    }
  });
});

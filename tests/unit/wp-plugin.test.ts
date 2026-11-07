import { describe, expect, it } from "vitest";
import path from "node:path";
import { headerField, parseChangelog, readPluginMeta } from "@/lib/wp-plugin";

describe("اطلاعات افزونه‌ی وردپرس برای به‌روزرسانی خودکار", () => {
  it("فیلد هدر PHP را می‌خواند", () => {
    expect(headerField(" * Version:           2.3.0\n", "Version")).toBe("2.3.0");
    expect(headerField("<?php\n/**\n * Requires PHP:      7.4\n", "Requires PHP")).toBe("7.4");
    expect(headerField("چیزی نیست", "Version")).toBe("");
  });

  it("فقط n نسخه‌ی آخر تغییرات را برمی‌گرداند و به بخش بعدی نمی‌رود", () => {
    const readme = "== Changelog ==\n= 2.3.0 =\n* a\n\n= 2.2.0 =\n* c\n\n= 2.1.0 =\n* d\n\n= 2.0.0 =\n* e\n\n== Upgrade Notice ==\n= 9.9.9 =\nx";
    const out = parseChangelog(readme, 3);
    expect(out).toContain("2.3.0");
    expect(out).toContain("2.1.0");
    expect(out).not.toContain("2.0.0");
    expect(out).not.toContain("9.9.9");
    expect(parseChangelog("بدون تغییرات")).toBe("");
  });

  it("افزونه‌ی همراه پروژه نسخه‌ی معتبر و تغییرات دارد", () => {
    const meta = readPluginMeta(path.join(process.cwd(), "wordpress-plugin", "emzagar-contracts"));
    expect(meta?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(meta?.changelog.length).toBeGreaterThan(10);
  });

  it("پوشه‌ی ناموجود null می‌دهد", () => {
    expect(readPluginMeta("/nonexistent/dir")).toBeNull();
  });
});

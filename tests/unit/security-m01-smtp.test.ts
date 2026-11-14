import { beforeEach, describe, expect, it, vi } from "vitest";

// M-01: DNS را کنترل می‌کنیم تا «DNS Rebinding» و میزبان‌های ترکیبی را بدون شبکه‌ی واقعی بیازماییم
const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ default: { lookup, resolveTxt: vi.fn() }, lookup, resolveTxt: vi.fn() }));

import { guardedSmtpOptions, isAllowedSmtpPort, SMTP_PORT_ALLOWLIST, SmtpTargetError } from "@/lib/smtp-guard";
import { sendMail } from "@/modules/mail";
import { saveSettings } from "@/modules/settings/service";
import { setupWorkspace } from "../flows";

const PUBLIC_IP = "93.184.216.34";

beforeEach(() => lookup.mockReset());

describe("M-01: فهرست سفید پورت SMTP", () => {
  it("فقط 25/465/587/2525 مجاز است؛ پورت سرویس‌های داخلی رد می‌شود", async () => {
    expect([...SMTP_PORT_ALLOWLIST]).toEqual([25, 465, 587, 2525]);
    for (const p of [22, 80, 3306, 5432, 6379, 9200, 11211, 27017]) {
      expect(isAllowedSmtpPort(p)).toBe(false);
      await expect(guardedSmtpOptions(PUBLIC_IP, p)).rejects.toBeInstanceOf(SmtpTargetError);
    }
    for (const p of [25, 465, 587, 2525]) await expect(guardedSmtpOptions(PUBLIC_IP, p)).resolves.toMatchObject({ port: p });
  });
  it("پورت نامعتبر به ۵۸۷ برمی‌گردد (نه اتصال به پورت دلخواه)", async () => {
    await expect(guardedSmtpOptions(PUBLIC_IP, "abc")).resolves.toMatchObject({ port: 587 });
    await expect(guardedSmtpOptions(PUBLIC_IP, "-1")).resolves.toMatchObject({ port: 587 });
  });
});

describe("M-01: مقصدهای داخلی هرگز اتصال نمی‌گیرند", () => {
  it("IP لیترال خصوصی/loopback/متادیتای ابر و نام‌های داخلی رد می‌شوند", async () => {
    for (const h of ["127.0.0.1", "10.0.0.5", "192.168.1.10", "172.16.0.1", "169.254.169.254", "[::1]", "::1", "localhost", "redis", "db.internal", "printer.local", "a.localhost", ""]) {
      await expect(guardedSmtpOptions(h, 587), h).rejects.toBeInstanceOf(SmtpTargetError);
    }
    expect(lookup).not.toHaveBeenCalled(); // بدون هیچ پرسش DNS رد شدند
  });
  it("نامی که حتی یکی از آدرس‌هایش داخلی است رد می‌شود", async () => {
    lookup.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(guardedSmtpOptions("mixed.example.com", 587)).rejects.toBeInstanceOf(SmtpTargetError);
  });
  it("نام بدون رکورد رد می‌شود", async () => {
    lookup.mockResolvedValue([]); // رکوردی نیست (NXDOMAIN/بدون A)
    await expect(guardedSmtpOptions("nx.example.com", 587)).rejects.toBeInstanceOf(SmtpTargetError);
  });
});

describe("M-01: پین‌کردن IP (ضد TOCTOU / DNS Rebinding)", () => {
  it("نام فقط یک بار resolve و اتصال مستقیم به همان IP عمومی با SNI نام اصلی است", async () => {
    // پاسخ اول عمومی؛ اگر کسی دوباره بپرسد (rebinding) به loopback می‌پرد
    lookup.mockResolvedValueOnce([{ address: PUBLIC_IP, family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const t = await guardedSmtpOptions("Rebind.Example.com", 465);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(t).toMatchObject({ host: PUBLIC_IP, port: 465, secure: true, tls: { servername: "rebind.example.com" } });
  });
  it("آدرس IPv4 بر IPv6 ترجیح داده می‌شود و SMTP پلتفرم (مورد اعتماد) دست‌نخورده می‌ماند", async () => {
    lookup.mockResolvedValue([{ address: "2606:4700::1111", family: 6 }, { address: PUBLIC_IP, family: 4 }]);
    expect((await guardedSmtpOptions("dual.example.com", 587)).host).toBe(PUBLIC_IP);
    const trusted = await guardedSmtpOptions("mailhog", 1025, { trusted: true });
    expect(trusted).toMatchObject({ host: "mailhog", port: 1025 });
  });
});

describe("M-01: sendMail با SMTP فضای کاری", () => {
  it("میزبان/پورت داخلی «failed» می‌شود، بدون اتصال شبکه و بدون نشت جزئیات", async () => {
    const { wsId } = await setupWorkspace("SMTP-SSRF");
    for (const [host, port] of [["127.0.0.1", "6379"], ["localhost", "587"], ["169.254.169.254", "25"], ["93.184.216.34", "5432"]] as const) {
      await saveSettings({ smtp_host: host, smtp_port: port }, wsId); // مسیر ذخیره را دور می‌زند: لایه‌ی ارسال هم باید بایستد
      const r = await sendMail({ to: "victim@example.com", subject: "x", html: "<p>x</p>", workspaceId: wsId });
      expect(r.status, `${host}:${port}`).toBe("failed");
      expect(r.error).toMatch(/مجاز|پورت SMTP/);
    }
  });
});

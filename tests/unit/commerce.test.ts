import { describe, expect, it } from "vitest";
import { makeNationalCode } from "../helpers";
import { isValidNationalCode, maskNationalCode, toLatinDigits } from "@/modules/kyc/rules";
import { CREDIT_PACKS, packById, perContract } from "@/modules/wallet/packs";
import { DEFAULT_REFERRAL, REFERRAL_CODE_RE, normalizeReferralCode, sanitizeReferralConfig } from "@/modules/referral/config";
import { authorityKey, tokenFromAuthority } from "@/modules/payments/types";
import { zarinpal } from "@/modules/payments/gateways/zarinpal";
import { zibal } from "@/modules/payments/gateways/zibal";
import { idpay } from "@/modules/payments/gateways/idpay";
import { payir } from "@/modules/payments/gateways/payir";

describe("کد ملی", () => {
  it("کد معتبر را می‌پذیرد و کد نامعتبر را رد می‌کند", () => {
    expect(isValidNationalCode(makeNationalCode("123456789"))).toBe(true);
    expect(isValidNationalCode("0499370899")).toBe(true);
    expect(isValidNationalCode("1234567890")).toBe(false);
    expect(isValidNationalCode("1111111111")).toBe(false);
    expect(isValidNationalCode("12345")).toBe(false);
    expect(isValidNationalCode("abcdefghij")).toBe(false);
  });
  it("ارقام فارسی و عربی را می‌پذیرد و ماسک می‌کند", () => {
    expect(toLatinDigits("۰۴۹۹۳۷۰۸۹۹")).toBe("0499370899");
    expect(isValidNationalCode("۰۴۹۹۳۷۰۸۹۹")).toBe(true);
    expect(maskNationalCode("0499370899")).toBe("•••••••899");
  });
});

describe("بسته‌های اعتباری و دعوت", () => {
  it("بسته‌ها منطقی‌اند: هرچه بزرگ‌تر، ارزان‌تر برای هر قرارداد", () => {
    const per = CREDIT_PACKS.map(perContract);
    expect([...per].sort((a, b) => b - a)).toEqual(per);
    expect(packById("c10")?.credits).toBe(10);
    expect(packById("nope")).toBeUndefined();
  });
  it("کد دعوت نرمال‌سازی و تنظیمات سالم‌سازی می‌شود", () => {
    expect(normalizeReferralCode(" emz-abc234 ")).toBe("EMZABC234");
    expect(REFERRAL_CODE_RE.test("EMZ7K3QX9")).toBe(true);
    expect(REFERRAL_CODE_RE.test("EMZ0O1IL9")).toBe(false);
    const c = sanitizeReferralConfig({ referrerWallet: -5, referredWallet: "abc", milestoneEvery: 999, enabled: false });
    expect(c.referrerWallet).toBe(0);
    expect(c.referredWallet).toBe(DEFAULT_REFERRAL.referredWallet);
    expect(c.milestoneEvery).toBe(100);
    expect(c.enabled).toBe(false);
  });
});

describe("آداپتور درگاه‌ها", () => {
  it("کلید یکتای تراکنش: زرین‌پال بدون پیشوند، بقیه با پیشوند درگاه", () => {
    expect(authorityKey("zarinpal", "A0001")).toBe("A0001");
    expect(authorityKey("zibal", "123456")).toBe("zibal:123456");
    expect(tokenFromAuthority("zibal", "zibal:123456")).toBe("123456");
    expect(tokenFromAuthority("zarinpal", "A0001")).toBe("A0001");
  });
  it("پارامترهای بازگشت هر درگاه به توکن و وضعیت تبدیل می‌شود", () => {
    expect(zarinpal.parseCallback(new URLSearchParams("Authority=A1&Status=OK"))).toEqual({ token: "A1", ok: true });
    expect(zarinpal.parseCallback(new URLSearchParams("Authority=A1&Status=NOK")).ok).toBe(false);
    expect(zibal.parseCallback(new URLSearchParams("success=1&status=2&trackId=99&orderId=5"))).toEqual({ token: "99", ok: true });
    expect(zibal.parseCallback(new URLSearchParams("success=0&trackId=99")).ok).toBe(false);
    expect(idpay.parseCallback(new URLSearchParams("status=10&id=abc&order_id=5"))).toEqual({ token: "abc", ok: true });
    expect(idpay.parseCallback(new URLSearchParams("status=7&id=abc")).ok).toBe(false);
    expect(payir.parseCallback(new URLSearchParams("status=1&token=tok"))).toEqual({ token: "tok", ok: true });
    expect(payir.parseCallback(new URLSearchParams("status=0&token=tok")).ok).toBe(false);
  });
  it("اعتبارنامه‌ی نامعتبر رد می‌شود", () => {
    expect(zarinpal.isValidCredential("12345678-1234-1234-1234-123456789012")).toBe(true);
    expect(zarinpal.isValidCredential("short")).toBe(false);
    expect(zibal.isValidCredential("zibal")).toBe(true);
    expect(idpay.isValidCredential("x")).toBe(false);
  });
});

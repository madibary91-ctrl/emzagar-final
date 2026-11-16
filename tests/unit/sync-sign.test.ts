import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "@/modules/sync/sign";
import { parseEvents, parseExternal } from "@/modules/sync/service";

describe("امضای HMAC همگام‌سازی", () => {
  const secret = "a".repeat(64);
  const body = JSON.stringify({ events: [{ id: "evt_123456", type: "order.upserted", data: { orderId: 1 } }] });
  const now = 1_700_000_000;

  it("امضای درست پذیرفته می‌شود", () => {
    expect(verifySignature(secret, String(now), signBody(secret, now, body), body, now)).toBe("ok");
  });
  it("بدنه‌ی دستکاری‌شده یا راز اشتباه رد می‌شود", () => {
    expect(verifySignature(secret, String(now), signBody(secret, now, body), body + " ", now)).toBe("mismatch");
    expect(verifySignature("b".repeat(64), String(now), signBody(secret, now, body), body, now)).toBe("mismatch");
  });
  it("برچسب زمان کهنه (بازپخش) رد می‌شود", () => {
    expect(verifySignature(secret, String(now - 301), signBody(secret, now - 301, body), body, now)).toBe("stale");
    expect(verifySignature(secret, String(now + 301), signBody(secret, now + 301, body), body, now)).toBe("stale");
  });
  it("هدر ناقص = missing", () => {
    expect(verifySignature(secret, null, null, body, now)).toBe("missing");
    expect(verifySignature("", String(now), "x", body, now)).toBe("missing");
  });
});

describe("اعتبارسنجی ورودی همگام‌سازی", () => {
  it("رویدادهای معتبر را می‌پذیرد و نامعتبر/بیش‌ازحد را رد می‌کند", () => {
    expect(parseEvents({ events: [{ id: "evt_abcdef", type: "order.upserted", data: {} }] })).toHaveLength(1);
    expect(parseEvents({ events: [] })).toBeNull();
    expect(parseEvents({})).toBeNull();
    expect(parseEvents({ events: [{ id: "x", type: "order.upserted" }] })).toBeNull();
    expect(parseEvents({ events: [{ id: "evt_abcdef", type: "DROP TABLE" }] })).toBeNull();
    expect(parseEvents({ events: Array.from({ length: 51 }, (_, i) => ({ id: `evt_${i}abcd`, type: "order.upserted" })) })).toBeNull();
  });
  it("مرجع خارجی فقط ووکامرس با کلید امن", () => {
    expect(parseExternal({ source: "woocommerce", orderId: 5, productId: 9, key: "wc:5:9" })).toMatchObject({ orderId: 5, key: "wc:5:9" });
    expect(parseExternal({ source: "other", key: "wc:5:9" })).toBeNull();
    expect(parseExternal({ source: "woocommerce", key: "bad key!" })).toBeNull();
    expect(parseExternal(null)).toBeNull();
  });
});

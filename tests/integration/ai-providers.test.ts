import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { createWorkspace } from "@/modules/tenancy/service";
import { saveSettings } from "@/modules/settings/service";
import { aiChat, aiTestConnection } from "@/modules/ai/client";
import { getAiConfig } from "@/modules/ai/service";
import { uniq } from "../helpers";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stub = (handler: (c: Call) => Response) =>
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    const c = { url: String(url), init };
    calls.push(c);
    return handler(c);
  });
const hdr = (c: Call, n: string) => (c.init.headers as Record<string, string>)[n];

let ws = 0;
beforeAll(async () => {
  const [u] = await db.insert(users).values({ name: "مدیر", email: `${uniq("ai")}@example.com`, passwordHash: hashPassword("x"), emailVerifiedAt: new Date() }).returning();
  ws = await createWorkspace(u.id, "فضای AI");
});
afterEach(() => {
  vi.unstubAllGlobals();
  calls = [];
});

describe("پشتیبانی از چند سرویس هوش مصنوعی", () => {
  it("OpenAI/Gemini/…: پروتکل chat/completions با Bearer", async () => {
    stub(() => reply({ choices: [{ message: { content: "سلام" } }], usage: { total_tokens: 42 } }));
    const r = await aiChat({ key: "sk-test-123456", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", provider: "openai" }, { system: "s", user: "u" });
    expect(r).toEqual({ text: "سلام", tokens: 42 });
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(hdr(calls[0], "Authorization")).toBe("Bearer sk-test-123456");
  });

  it("Claude: پروتکل بومی /messages با x-api-key و system جدا", async () => {
    stub(() => reply({ content: [{ type: "text", text: "درود" }, { type: "text", text: "دنیا" }], usage: { input_tokens: 10, output_tokens: 5 } }));
    const r = await aiChat({ key: "sk-ant-test-123456", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5", provider: "anthropic" }, { system: "قواعد", user: "پرسش", maxTokens: 100 });
    expect(r).toEqual({ text: "درود\nدنیا", tokens: 15 });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(hdr(calls[0], "x-api-key")).toBe("sk-ant-test-123456");
    expect(hdr(calls[0], "anthropic-version")).toBeTruthy();
    expect(hdr(calls[0], "Authorization")).toBeUndefined();
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.system).toBe("قواعد");
    expect(body.messages).toEqual([{ role: "user", content: "پرسش" }]);
    expect(body.max_tokens).toBe(100);
  });

  it("خطاهای HTTP به پیام فارسی تبدیل می‌شوند", async () => {
    for (const [status, re] of [[401, /نامعتبر/], [429, /محدودیت/], [404, /\(404\)/]] as const) {
      stub(() => reply({ error: "x" }, status));
      await expect(aiChat({ key: "k-123456789", baseUrl: "https://api.openai.com/v1", model: "m", provider: "openai" }, { system: "s", user: "u" })).rejects.toThrow(re);
    }
  });

  it("تست اتصال Claude: فهرست مدل‌ها از /models و حذف پیشوند models/ در Gemini", async () => {
    stub(() => reply({ data: [{ id: "claude-haiku-4-5" }, { id: "claude-sonnet-4-5" }] }));
    const a = await aiTestConnection({ key: "sk-ant-test-123456", baseUrl: "https://api.anthropic.com/v1", model: "x", provider: "anthropic" });
    expect(a).toEqual({ ok: true, models: ["claude-haiku-4-5", "claude-sonnet-4-5"] });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/models");
    stub(() => reply({ data: [{ id: "models/gemini-2.5-flash" }] }));
    const g = await aiTestConnection({ key: "AIza-test-123456", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "x", provider: "gemini" });
    expect(g).toEqual({ ok: true, models: ["gemini-2.5-flash"] });
    stub(() => reply({}, 401));
    expect((await aiTestConnection({ key: "bad-key-123456", baseUrl: "https://api.openai.com/v1", model: "x", provider: "openai" })).ok).toBe(false);
  });

  it("آدرس داخلی/ناامن (SSRF) برای سرویس دلخواه رد می‌شود", async () => {
    stub(() => reply({}));
    const r = await aiTestConnection({ key: "k-123456789", baseUrl: "http://169.254.169.254/v1", model: "x", provider: "custom" });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("getAiConfig: سرویس انتخابی هر فضای کاری، پیش‌فرض‌ها و سازگاری با نسخه‌ی قبل", async () => {
    const none = await getAiConfig(ws);
    expect(none.provider).toBe("gapgpt");
    await saveSettings({ ai_provider: "anthropic", ai_api_key: "sk-ant-abcdefgh" }, ws);
    const c = await getAiConfig(ws);
    expect(c).toMatchObject({ provider: "anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5", source: "workspace" });
    await saveSettings({ ai_provider: "custom", ai_base_url: "https://llm.example.com/v1", ai_model: "my-model" }, ws);
    expect(await getAiConfig(ws)).toMatchObject({ provider: "custom", baseUrl: "https://llm.example.com/v1", model: "my-model" });
    // نسخه‌ی قدیمی: بدون ai_provider ولی با آدرس اختصاصی = سرویس دلخواه
    await saveSettings({ ai_provider: "", ai_base_url: "https://api.openai.com/v1" }, ws);
    expect((await getAiConfig(ws)).provider).toBe("custom");
    await saveSettings({ ai_provider: "", ai_base_url: "" }, ws);
    expect((await getAiConfig(ws)).provider).toBe("gapgpt");
  });
});

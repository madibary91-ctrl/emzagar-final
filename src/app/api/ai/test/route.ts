import { NextResponse } from "next/server";
import { getTeamForApi } from "@/modules/tenancy/context";
import { getAiConfig, testAiConnection } from "@/modules/ai/service";
import { PROVIDERS, isProviderId, type AiProviderId } from "@/modules/ai/providers";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "Cache-Control": "no-store" } });

/** تست اتصال به سرویس هوش مصنوعی با کلید ذخیره‌شده یا کلیدِ تازه‌واردشده (بدون ذخیره‌سازی) */
export async function POST(req: Request) {
  const team = await getTeamForApi("settings");
  if (!team) return json({ ok: false, error: "دسترسی ندارید" }, 403);
  if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ ok: false, error: "نوع درخواست نامعتبر است" }, 415);
  const rl = rateLimit(`ai-test:${team.id}`, 8, 60_000);
  if (!rl.ok) return json({ ok: false, error: `کمی صبر کنید (${rl.retryAfter} ثانیه)` }, 429);

  const body = (await req.json().catch(() => null)) as { key?: string; baseUrl?: string; model?: string; provider?: string } | null;
  const saved = await getAiConfig(team.workspaceId);
  const typedKey = String(body?.key || "").trim();
  const provider: AiProviderId = isProviderId(body?.provider) ? body.provider : saved.provider;
  const info = PROVIDERS[provider];

  // کلید ذخیره‌شده فقط برای همان سرویسی که ذخیره شده فرستاده می‌شود (جلوگیری از نشت کلید به سرویس دیگر)
  if (!typedKey && saved.key && provider !== saved.provider) {
    return json({ ok: false, error: "برای تست این سرویس، کلید API همان سرویس را وارد کنید" }, 422);
  }
  const key = typedKey || saved.key;
  const typedBase = String(body?.baseUrl || "").trim().replace(/\/+$/, "");
  const sameProvider = provider === saved.provider;
  const baseUrl = typedBase || (sameProvider ? saved.baseUrl : "") || info.baseUrl;
  if (!baseUrl) return json({ ok: false, error: "آدرس سرویس را وارد کنید" }, 422);
  const model = String(body?.model || "").trim() || (sameProvider ? saved.model : "") || info.defaultModel;
  const r = await testAiConnection({ key, baseUrl, model, provider });
  return json(r, r.ok ? 200 : 422);
}

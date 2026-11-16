import { NextResponse } from "next/server";
import { getTeamForApi } from "@/modules/tenancy/context";
import { MAX_EXISTING_HTML_CHARS, MAX_PROMPT_CHARS, aiConfigured, generateWithAi, usageToday, type AiLength, type AiMode } from "@/modules/ai/service";
import { knowledgeStats } from "@/modules/ai/knowledge/service";
import { logAudit } from "@/modules/audit/service";
import { rateLimit } from "@/lib/rate-limit";
import { can } from "@/modules/tenancy/roles";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** وضعیت دستیار و سهمیه‌ی باقی‌مانده */
export async function GET() {
  const team = await getTeamForApi("write");
  if (!team) return json({ ok: false, error: "دسترسی ندارید" }, 403);
  const u = await usageToday(team.workspaceId);
  return json({ ok: true, configured: await aiConfigured(team.workspaceId), canConfigure: can(team.wsRole, "settings"), used: u.used, limit: u.limit, knowledge: await knowledgeStats(team.workspaceId) });
}

/** تولید یا بهبود متن قرارداد (فقط اعضای دارای دسترسی نوشتن) */
export async function POST(req: Request) {
  const team = await getTeamForApi("write");
  if (!team) return json({ ok: false, error: "دسترسی ندارید" }, 403);
  if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ ok: false, error: "نوع درخواست نامعتبر است" }, 415);

  const rl = rateLimit(`ai:${team.id}`, 6, 60_000);
  if (!rl.ok) return json({ ok: false, error: `درخواست‌های پشت‌سرهم زیاد بود؛ ${rl.retryAfter} ثانیه صبر کنید` }, 429);

  const body = (await req.json().catch(() => null)) as { prompt?: string; mode?: string; length?: string; existingHtml?: string; personalize?: boolean } | null;
  // AI-03: ورودی بیش از سقف «رد می‌شود» (بریدن بی‌صدا دستور/متن، نتیجه‌ی خراب و حذف بخشی از قرارداد می‌داد)
  const prompt = String(body?.prompt || "").trim();
  if (prompt.length > MAX_PROMPT_CHARS) return json({ ok: false, error: `توضیحات بیش از ${MAX_PROMPT_CHARS.toLocaleString("fa-IR")} نویسه است؛ کوتاه‌تر بنویسید` }, 422);
  if (prompt.length < 8) return json({ ok: false, error: "توضیحات را کمی کامل‌تر بنویسید (حداقل ۸ نویسه)" }, 422);
  const mode: AiMode = body?.mode === "improve" ? "improve" : "generate";
  const length: AiLength = body?.length === "short" || body?.length === "detailed" ? body.length : "standard";
  if (mode === "improve" && !String(body?.existingHtml || "").trim()) return json({ ok: false, error: "ویرایشگر خالی است؛ ابتدا متنی بنویسید یا حالت «نوشتن جدید» را بزنید" }, 422);

  const existingHtml = String(body?.existingHtml || "");
  if (mode === "improve" && existingHtml.length > MAX_EXISTING_HTML_CHARS) return json({ ok: false, error: "متن ویرایشگر برای بازنویسی با هوش مصنوعی بیش از حد بزرگ است؛ فقط بخش موردنظر را جداگانه بازنویسی کنید." }, 413);

  const r = await generateWithAi({
    workspaceId: team.workspaceId,
    workspaceName: team.workspaceName,
    userId: team.id,
    mode,
    prompt,
    length,
    existingHtml,
    personalize: body?.personalize !== false,
  });
  if (!r.ok) {
    const res = json({ ok: false, error: r.error }, r.status);
    if (r.retryAfter) res.headers.set("Retry-After", String(r.retryAfter));
    return res;
  }
  await logAudit({ action: "ai.generated", workspaceId: team.workspaceId, userId: team.id, detail: `${mode === "improve" ? "بهبود" : "نگارش"}${r.personalized ? " (با حافظه‌ی حقوقی)" : ""}: ${prompt.slice(0, 80)}` });
  return json({ ok: true, html: r.html, remaining: r.remaining, personalized: r.personalized, sources: r.sources, ...(r.warning ? { warning: r.warning } : {}) });
}

import { NextResponse } from "next/server";
import { getTeamForApi } from "@/modules/tenancy/context";
import { aiConfigured, generateWithAi, usageToday, type AiLength, type AiMode } from "@/modules/ai/service";
import { knowledgeStats } from "@/modules/ai/knowledge/service";
import { logAudit } from "@/modules/audit/service";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** وضعیت دستیار و سهمیه‌ی باقی‌مانده */
export async function GET() {
  const team = await getTeamForApi("write");
  if (!team) return json({ ok: false, error: "دسترسی ندارید" }, 403);
  const u = await usageToday(team.workspaceId);
  return json({ ok: true, configured: await aiConfigured(team.workspaceId), used: u.used, limit: u.limit, knowledge: await knowledgeStats(team.workspaceId) });
}

/** تولید یا بهبود متن قرارداد (فقط اعضای دارای دسترسی نوشتن) */
export async function POST(req: Request) {
  const team = await getTeamForApi("write");
  if (!team) return json({ ok: false, error: "دسترسی ندارید" }, 403);
  if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ ok: false, error: "نوع درخواست نامعتبر است" }, 415);

  const rl = rateLimit(`ai:${team.id}`, 6, 60_000);
  if (!rl.ok) return json({ ok: false, error: `درخواست‌های پشت‌سرهم زیاد بود؛ ${rl.retryAfter} ثانیه صبر کنید` }, 429);

  const body = (await req.json().catch(() => null)) as { prompt?: string; mode?: string; length?: string; existingHtml?: string; personalize?: boolean } | null;
  const prompt = String(body?.prompt || "").trim().slice(0, 2000);
  if (prompt.length < 8) return json({ ok: false, error: "توضیحات را کمی کامل‌تر بنویسید (حداقل ۸ نویسه)" }, 422);
  const mode: AiMode = body?.mode === "improve" ? "improve" : "generate";
  const length: AiLength = body?.length === "short" || body?.length === "detailed" ? body.length : "standard";
  if (mode === "improve" && !String(body?.existingHtml || "").trim()) return json({ ok: false, error: "ویرایشگر خالی است؛ ابتدا متنی بنویسید یا حالت «نوشتن جدید» را بزنید" }, 422);

  const r = await generateWithAi({
    workspaceId: team.workspaceId,
    workspaceName: team.workspaceName,
    userId: team.id,
    mode,
    prompt,
    length,
    existingHtml: String(body?.existingHtml || "").slice(0, 60000),
    personalize: body?.personalize !== false,
  });
  if (!r.ok) return json({ ok: false, error: r.error }, r.status);
  await logAudit({ action: "ai.generated", workspaceId: team.workspaceId, userId: team.id, detail: `${mode === "improve" ? "بهبود" : "نگارش"}${r.personalized ? " (با حافظه‌ی حقوقی)" : ""}: ${prompt.slice(0, 80)}` });
  return json({ ok: true, html: r.html, remaining: r.remaining, personalized: r.personalized, sources: r.sources });
}

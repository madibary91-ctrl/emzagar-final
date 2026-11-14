"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { rateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/modules/audit/service";
import { analyzeContractText } from "./service";
import type { RiskResult } from "./rules";

export type RiskState = {
  error?: string;
  id?: number;
  title?: string;
  result?: RiskResult;
  engine?: "rules" | "ai+rules";
  aiNote?: string;
};

/** تحلیل ریسک یک قرارداد موجود (فقط همین فضای کاری) یا متن دلخواه؛ تحلیل AI از سهمیه‌ی هوش مصنوعی کم می‌کند */
export async function analyzeRiskAction(_prev: RiskState, formData: FormData): Promise<RiskState> {
  const team = await requireTeam("write");
  if (!rateLimit(`risk:${team.id}`, 8, 60_000).ok) return { error: "درخواست‌های پشت‌سرهم زیاد بود؛ یک دقیقه صبر کنید." };

  const contractId = Number(formData.get("contractId"));
  const useAi = formData.get("useAi") === "on";
  let title = String(formData.get("title") || "").trim().slice(0, 200);
  let html = String(formData.get("text") || "").slice(0, 60_000);
  let cid: number | null = null;

  if (Number.isInteger(contractId) && contractId > 0) {
    const [c] = await db.select().from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.workspaceId, team.workspaceId)));
    if (!c) return { error: "قرارداد یافت نشد" };
    html = c.bodyHtml;
    title = c.title;
    cid = c.id;
  }
  if (html.replace(/<[^>]*>/g, "").trim().length < 30) return { error: "متن قرارداد را وارد کنید یا یک قرارداد را انتخاب کنید (حداقل ۳۰ نویسه)." };
  if (!title) title = "متن دلخواه";

  try {
    const r = await analyzeContractText({ workspaceId: team.workspaceId, userId: team.id, contractId: cid, title, html, useAi });
    await logAudit({ action: "risk.analyzed", workspaceId: team.workspaceId, userId: team.id, contractId: cid, detail: `${title} — امتیاز ${r.result.score}` });
    return { id: r.id, title, result: r.result, engine: r.engine, aiNote: r.aiNote };
  } catch (e) {
    console.error("[risk]", e);
    return { error: "خطا در تحلیل؛ دوباره تلاش کنید." };
  }
}

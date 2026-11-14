import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { workspaceOfContract } from "@/modules/tenancy/service";
import { afterCommit, db } from "@/db";
import { webhookDeliveries, webhookEndpoints } from "@/db/schema";

import { assertSafeUrl, safeFetch } from "@/lib/ssrf";
import { EXPLICIT_ONLY_EVENTS, type WebhookProvider } from "./meta";
export { assertSafeUrl };
export { EVENTS, PROVIDERS } from "./meta";

const API_BASES: Record<Exclude<WebhookProvider, "generic">, string> = {
  telegram: "https://api.telegram.org",
  bale: "https://tapi.bale.ai",
  rubika: "https://botapi.rubika.ir",
  eitaa: "https://eitaayar.ir",
};

export interface WebhookEvent {
  event: string;
  /** فضای کاری مقصد؛ اگر نبود از روی قرارداد تعیین می‌شود (بدون هیچ‌کدام: ارسال نمی‌شود) */
  workspaceId?: number;
  contractId?: number | null;
  /** متن فارسی آماده‌ی نمایش در پیام‌رسان */
  text: string;
  data?: Record<string, string | number | null>;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await safeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // پیام‌رسان‌ها گاهی با کد 200 و ok=false پاسخ می‌دهند
  const json = (await res.json().catch(() => null)) as { ok?: boolean; status?: string; description?: string } | null;
  if (json && (json.ok === false || json.status === "INVALID_INPUT" || json.status === "INVALID_ACCESS")) {
    throw new Error(json.description || json.status || "پاسخ ناموفق");
  }
}

type Endpoint = typeof webhookEndpoints.$inferSelect;

async function deliver(ep: Endpoint, ev: WebhookEvent) {
  if (ep.provider === "generic") {
    const url = await assertSafeUrl(ep.target);
    const payload = JSON.stringify({ event: ev.event, contractId: ev.contractId ?? null, text: ev.text, data: ev.data ?? {}, at: new Date().toISOString() });
    const sig = crypto.createHmac("sha256", ep.secret || "").update(payload).digest("hex");
    const res = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Emzagar-Event": ev.event, "X-Emzagar-Signature": `sha256=${sig}` },
      body: payload,
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return;
  }
  const provider = ep.provider as Exclude<WebhookProvider, "generic">;
  const base = ep.baseUrl ? (await assertSafeUrl(ep.baseUrl)).origin : API_BASES[provider];
  const token = encodeURIComponent(ep.secret);
  if (provider === "eitaa") {
    // ایتایار: ارسال یک‌طرفه به کانال/گروه (فرم‌دیتا)؛ ایتا وب‌هوک و دکمه‌ی تعاملی ندارد
    const res = await safeFetch(`${base}/api/${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ chat_id: ep.target, text: ev.text }).toString(),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (j && j.ok === false) throw new Error(j.description || "پاسخ ناموفق");
    return;
  }
  const url = provider === "rubika" ? `${base}/v3/${token}/sendMessage` : `${base}/bot${token}/sendMessage`;
  await post(url, { chat_id: ep.target, text: ev.text });
}

async function run(ev: WebhookEvent) {
  // همگام‌سازی با ووکامرس: وضعیت قراردادهای صادرشده از فروشگاه به سایت وردپرس برمی‌گردد (صف خروجی + Push/Pull)
  if (ev.contractId && ev.event.startsWith("contract.")) {
    void import("@/modules/sync/service").then((m) => (m.SYNC_CONTRACT_EVENTS as readonly string[]).includes(ev.event) ? m.enqueueContractEvent(ev.contractId as number, ev.event) : undefined).catch(() => undefined);
  }
  const workspaceId = ev.workspaceId ?? (await workspaceOfContract(ev.contractId));
  if (!workspaceId) return;
  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.active, true), eq(webhookEndpoints.workspaceId, workspaceId)));
  const explicitOnly = EXPLICIT_ONLY_EVENTS.includes(ev.event);
  const targets = endpoints.filter((e) => (e.events === "*" && !explicitOnly) || e.events.split(",").includes(ev.event) || ev.event === "test");
  await Promise.allSettled(
    targets.map(async (ep) => {
      let status = "ok";
      let error: string | null = null;
      try {
        await deliver(ep, ev);
      } catch (e) {
        status = "failed";
        error = (e instanceof Error ? e.message : "خطای ناشناخته").slice(0, 300);
      }
      await db.insert(webhookDeliveries).values({ endpointId: ep.id, event: ev.event, status, error, contractId: ev.contractId ?? null });
    }),
  );
}

/**
 * ارسال رویداد به همه‌ی مقصدهای فعال؛ هرگز جریان اصلی (امضا/صدور) را مسدود یا خراب نمی‌کند.
 * اگر داخل تراکنش صدا زده شود، رویداد فقط پس از commit موفق ارسال می‌شود (و با rollback ارسال نمی‌شود)؛
 * بنابراین هیچ وب‌هوکی درباره‌ی چیزی که در دیتابیس ثبت نشده بیرون نمی‌رود.
 */
export function emitEvent(ev: WebhookEvent): void {
  void afterCommit(() => run(ev).catch(() => undefined));
}

/** ارسال آزمایشی به یک مقصد مشخص (برای دکمه‌ی «تست» در پنل) */
export async function sendTest(endpointId: number, workspaceId: number): Promise<{ ok: boolean; error?: string }> {
  const [ep] = await db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspaceId, workspaceId)));
  if (!ep) return { ok: false, error: "مقصد یافت نشد" };
  try {
    await deliver(ep, { event: "test", text: "✅ پیام آزمایشی از سامانه‌ی امضاگیر — اتصال برقرار است." });
    await db.insert(webhookDeliveries).values({ endpointId: ep.id, event: "test", status: "ok" });
    return { ok: true };
  } catch (e) {
    const error = (e instanceof Error ? e.message : "خطا").slice(0, 300);
    await db.insert(webhookDeliveries).values({ endpointId: ep.id, event: "test", status: "failed", error });
    return { ok: false, error };
  }
}

/** فهرست مقصدها بدون توکن (امن برای ارسال به کلاینت) */
export async function listEndpointsSafe(workspaceId: number) {
  const rows = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.workspaceId, workspaceId)).orderBy(desc(webhookEndpoints.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    provider: r.provider,
    target: r.provider === "generic" ? r.target : r.target,
    hasSecret: !!r.secret,
    baseUrl: r.baseUrl,
    events: r.events,
    active: r.active,
  }));
}

export async function recentDeliveries(workspaceId: number, limit = 30) {
  return db
    .select({
      id: webhookDeliveries.id,
      event: webhookDeliveries.event,
      status: webhookDeliveries.status,
      error: webhookDeliveries.error,
      createdAt: webhookDeliveries.createdAt,
      endpointName: webhookEndpoints.name,
      provider: webhookEndpoints.provider,
    })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(eq(webhookEndpoints.workspaceId, workspaceId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);
}

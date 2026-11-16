import crypto from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { workspaceOfContract } from "@/modules/tenancy/service";
import { afterCommit, db } from "@/db";
import { webhookDeliveries, webhookEndpoints } from "@/db/schema";

import { assertSafeUrl } from "@/lib/ssrf";
import { EXPLICIT_ONLY_EVENTS } from "./meta";
import { deliver, type WebhookEvent } from "./deliver";
import { recordFailure } from "./retry";
import { explainDeliveryError, type ExplainedError } from "./explain";
import { MAX_ENDPOINTS_PER_WORKSPACE, checkEndpointInput, newSigningSecret, type Checked } from "./validate";
export { assertSafeUrl };
export type { WebhookEvent };
export { EVENTS, PROVIDERS } from "./meta";

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
  const at = new Date().toISOString();
  await Promise.allSettled(
    targets.map(async (ep) => {
      // شناسه‌ی یکتای هر ارسال (به‌ازای هر مقصد): مقصد (مثلاً وردپرس) با آن تکراری‌ها را در تلاش‌های مجدد حذف می‌کند
      const stored = { event: ev.event, workspaceId, contractId: ev.contractId ?? null, text: ev.text, data: ev.data, at, deliveryKey: crypto.randomUUID() };
      try {
        await deliver(ep, stored, 1);
        await db.insert(webhookDeliveries).values({ endpointId: ep.id, event: ev.event, status: "ok", error: null, contractId: ev.contractId ?? null, lastAttemptAt: new Date() });
      } catch (e) {
        // شکست: ماندن در صف و تلاش مجدد با فاصله‌ی افزایشی (خطای دائمی 4xx مستقیم dead می‌شود)
        const error = (e instanceof Error ? e.message : "خطای ناشناخته").slice(0, 300);
        await recordFailure({ endpointId: ep.id, ev: stored, error, provider: ep.provider }).catch(() => undefined);
      }
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

/**
 * ارسال آزمایشی به یک مقصد مشخص (برای دکمه‌ی «تست» در پنل).
 * خطا به «علت + راه‌حل» فارسی ترجمه می‌شود و متن خام فنی هم جدا برمی‌گردد.
 * شکست آزمایشی «dead» ثبت می‌شود (نه «failed»)؛ چون هیچ‌وقت در صف تلاش مجدد نمی‌ماند و نباید در جدول
 * «در صف تلاش مجدد» نمایش داده شود (بن‌بستی که کاربر منتظر تلاشی می‌ماند که هرگز نمی‌آید).
 */
export async function sendTest(endpointId: number, workspaceId: number): Promise<{ ok: boolean; error?: string; raw?: string; kind?: ExplainedError["kind"] }> {
  const [ep] = await db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspaceId, workspaceId)));
  if (!ep) return { ok: false, error: "مقصد یافت نشد" };
  try {
    await deliver(ep, { event: "test", text: "✅ پیام آزمایشی از سامانه‌ی امضاگیر — اتصال برقرار است." });
    await db.insert(webhookDeliveries).values({ endpointId: ep.id, event: "test", status: "ok", lastAttemptAt: new Date() });
    return { ok: true };
  } catch (e) {
    const raw = (e instanceof Error ? e.message : "خطا").slice(0, 300);
    await db.insert(webhookDeliveries).values({ endpointId: ep.id, event: "test", status: "dead", error: raw, lastAttemptAt: new Date() });
    const x = explainDeliveryError(raw, ep.provider);
    return { ok: false, error: `${x.title}. ${x.hint}`, raw, kind: x.kind };
  }
}

/** ایجاد مقصد جدید؛ برای وب‌هوک عمومی بدون کلید، کلید امضای قوی خودکار ساخته و «فقط همین یک بار» برگردانده می‌شود */
export async function createEndpoint(workspaceId: number, input: Parameters<typeof checkEndpointInput>[0]): Promise<{ ok: true; id: number; generatedSecret?: string } | { ok: false; error: string; field?: string }> {
  const c: Checked = await checkEndpointInput(input);
  if (!c.ok) return c;
  const [cnt] = await db.select({ n: sql<number>`count(*)::int` }).from(webhookEndpoints).where(eq(webhookEndpoints.workspaceId, workspaceId));
  if ((cnt?.n ?? 0) >= MAX_ENDPOINTS_PER_WORKSPACE) return { ok: false, error: `حداکثر ${MAX_ENDPOINTS_PER_WORKSPACE} مقصد مجاز است؛ مقصدهای بلااستفاده را حذف کنید.` };
  const generic = input.provider === "generic";
  const generatedSecret = generic && !c.value.secret ? newSigningSecret() : undefined;
  const [row] = await db
    .insert(webhookEndpoints)
    .values({ workspaceId, provider: input.provider, name: c.value.name, target: c.value.target, secret: generatedSecret ?? c.value.secret, baseUrl: c.value.baseUrl, events: c.value.events })
    .returning({ id: webhookEndpoints.id });
  return { ok: true, id: row.id, generatedSecret };
}

/**
 * ویرایش مقصد بدون از دست رفتن تاریخچه و صف تلاش مجدد (حذف و ساخت دوباره همه‌ی آن‌ها را پاک می‌کرد).
 * توکن/کلید خالی = بدون تغییر. rotateSecret (فقط وب‌هوک عمومی) کلید تازه می‌سازد و یک‌بار برمی‌گرداند.
 * بعد از اصلاح، ارسال‌های «dead» با «تلاش دوباره» قابل احیا هستند.
 */
export async function updateEndpoint(
  workspaceId: number,
  id: number,
  input: { name: string; target: string; secret: string; baseUrl: string; events: string[]; rotateSecret?: boolean },
): Promise<{ ok: true; generatedSecret?: string } | { ok: false; error: string; field?: string }> {
  const [ep] = await db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspaceId, workspaceId)));
  if (!ep) return { ok: false, error: "مقصد یافت نشد" };
  const keepSecret = !input.secret.trim();
  const c = await checkEndpointInput({ provider: ep.provider, name: input.name, target: input.target, secret: keepSecret ? ep.secret : input.secret, baseUrl: input.baseUrl, events: input.events });
  if (!c.ok) return c;
  const rotated = ep.provider === "generic" && input.rotateSecret ? newSigningSecret() : undefined;
  await db
    .update(webhookEndpoints)
    .set({ name: c.value.name, target: c.value.target, secret: rotated ?? (keepSecret ? ep.secret : c.value.secret), baseUrl: c.value.baseUrl, events: c.value.events })
    .where(eq(webhookEndpoints.id, ep.id));
  return { ok: true, generatedSecret: rotated };
}

export type EndpointHealth = {
  /** وضعیت آخرین ارسال واقعی/آزمایشی: ok | queued (در صف تلاش مجدد) | dead | none */
  last: "ok" | "queued" | "dead" | "none";
  lastAt: Date | null;
  okCount: number;
  badCount: number;
  queued: number;
  explained: ExplainedError | null;
};

/** فهرست مقصدها بدون توکن (امن برای ارسال به کلاینت) + سلامت هر مقصد از روی ۷ روز اخیر */
export async function listEndpointsSafe(workspaceId: number) {
  const rows = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.workspaceId, workspaceId)).orderBy(desc(webhookEndpoints.createdAt));
  const ids = rows.map((r) => r.id);
  const recent = ids.length
    ? await db
        .select({ endpointId: webhookDeliveries.endpointId, status: webhookDeliveries.status, error: webhookDeliveries.error, at: sql<Date>`coalesce(${webhookDeliveries.lastAttemptAt}, ${webhookDeliveries.createdAt})` })
        .from(webhookDeliveries)
        .where(and(inArray(webhookDeliveries.endpointId, ids), sql`${webhookDeliveries.createdAt} > now() - interval '7 days'`))
        .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
        .limit(1000)
    : [];
  return rows.map((r) => {
    const mine = recent.filter((d) => d.endpointId === r.id);
    const first = mine[0];
    const health: EndpointHealth = {
      last: !first ? "none" : first.status === "ok" ? "ok" : first.status === "failed" ? "queued" : "dead",
      lastAt: first ? new Date(first.at) : null,
      okCount: mine.filter((d) => d.status === "ok").length,
      badCount: mine.filter((d) => d.status !== "ok").length,
      queued: mine.filter((d) => d.status === "failed").length,
      explained: first && first.status !== "ok" ? explainDeliveryError(first.error, r.provider) : null,
    };
    return {
      id: r.id,
      name: r.name,
      provider: r.provider,
      target: r.target,
      hasSecret: !!r.secret,
      baseUrl: r.baseUrl,
      events: r.events,
      active: r.active,
      health,
    };
  });
}

export async function recentDeliveries(workspaceId: number, limit = 30) {
  return db
    .select({
      id: webhookDeliveries.id,
      event: webhookDeliveries.event,
      status: webhookDeliveries.status,
      error: webhookDeliveries.error,
      attempts: webhookDeliveries.attempts,
      nextRetryAt: webhookDeliveries.nextRetryAt,
      retryable: sql<boolean>`${webhookDeliveries.payload} is not null`,
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

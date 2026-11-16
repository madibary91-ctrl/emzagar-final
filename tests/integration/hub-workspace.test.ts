/**
 * «میز کار قراردادها» (سمت ابر برای وردپرس): کانبان، جستجو، جزئیات، لغو و PDF از طریق Route Handlerهای واقعی
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, auditLogs, templates } from "@/db/schema";
import { generateKey } from "@/modules/api/service";
import { GET as pipelineGET } from "@/app/api/v1/hub/pipeline/route";
import { GET as searchGET } from "@/app/api/v1/hub/search/route";
import { GET as detailGET } from "@/app/api/v1/hub/contract/[id]/route";
import { POST as cancelPOST } from "@/app/api/v1/contracts/[id]/cancel/route";
import { GET as pdfGET } from "@/app/api/v1/contracts/[id]/pdf/route";
import { GET as listGET } from "@/app/api/v1/contracts/route";
import { newContract, setupWorkspace, signAll } from "../flows";
import { setIp } from "../helpers";

const origin = "http://localhost:3000";
let key = "";
let otherKey = "";
let wsId = 0;
let sentId = 0;
let signedId = 0;
let ownerId = 0;

const h = () => ({ authorization: `Bearer ${key}` });
const call = (path: string, init: RequestInit = {}) => new Request(`${origin}${path}`, { ...init, headers: { ...h(), ...(init.headers as Record<string, string> | undefined) } });
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

async function makeKey(workspaceId: number) {
  const k = generateKey();
  await db.insert(apiKeys).values({ workspaceId, name: "test", prefix: k.prefix, keyHash: k.hash, active: true } as typeof apiKeys.$inferInsert);
  return k.plain;
}

beforeAll(async () => {
  setIp("10.9.8.7");
  const a = await setupWorkspace("میز کار A");
  const b = await setupWorkspace("میز کار B");
  wsId = a.wsId;
  ownerId = a.owner.id;
  key = await makeKey(a.wsId);
  otherKey = await makeKey(b.wsId);
  const sent = await newContract(a.wsId, a.owner.id, { title: "قرارداد پروژه‌ی آلفا" });
  sentId = sent.id;
  const signed = await newContract(a.wsId, a.owner.id, { title: "قرارداد نگهداری بتا" });
  signedId = signed.id;
  await signAll(signed.id);
  await db.insert(auditLogs).values({ workspaceId: a.wsId, contractId: sent.id, action: "contract.viewed", detail: "x" });
  await db.insert(templates).values({ workspaceId: a.wsId, title: "قالب اختصاصی گاما", body: "<p>x</p>", description: "" } as typeof templates.$inferInsert);
});

describe("کانبان", () => {
  it("بدون کلید ۴۰۱ و با کلید ستون‌های پنج‌گانه", async () => {
    expect((await pipelineGET(new Request(`${origin}/api/v1/hub/pipeline`))).status).toBe(401);
    const r = await pipelineGET(call("/api/v1/hub/pipeline"));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; total: number; stages: { key: string; count: number; items: { id: number }[] }[] };
    expect(j.stages.map((s) => s.key)).toEqual(["sent", "viewed", "signed", "rejected", "expired"]);
    // قرارداد بازشده در «مشاهده‌شده» و امضاشده در «امضاشده» است
    expect(j.stages.find((s) => s.key === "viewed")!.items.map((i) => i.id)).toContain(sentId);
    expect(j.stages.find((s) => s.key === "signed")!.items.map((i) => i.id)).toContain(signedId);
    expect(j.total).toBeGreaterThanOrEqual(2);
  });

  it("فضای کاری دیگر قراردادهای این فضا را نمی‌بیند", async () => {
    const r = await pipelineGET(new Request(`${origin}/api/v1/hub/pipeline`, { headers: { authorization: `Bearer ${otherKey}` } }));
    const j = (await r.json()) as { total: number };
    expect(j.total).toBe(0);
  });
});

describe("جستجو و فهرست", () => {
  it("قرارداد و قالب را پیدا می‌کند و کاراکترهای ویژه LIKE را خنثی می‌کند", async () => {
    const j = (await (await searchGET(call("/api/v1/hub/search?q=" + encodeURIComponent("آلفا")))).json()) as { contracts: { id: number }[]; templates: unknown[] };
    expect(j.contracts.map((c) => c.id)).toContain(sentId);
    const t = (await (await searchGET(call("/api/v1/hub/search?q=" + encodeURIComponent("گاما")))).json()) as { templates: { title: string }[] };
    expect(t.templates[0]?.title).toContain("گاما");
    const wild = (await (await searchGET(call("/api/v1/hub/search?q=%25%25"))).json()) as { contracts: unknown[] };
    expect(wild.contracts).toHaveLength(0);
    const short = (await (await searchGET(call("/api/v1/hub/search?q=a"))).json()) as { contracts: unknown[] };
    expect(short.contracts).toHaveLength(0);
  });

  it("پارامتر q به فهرست قراردادها اضافه شد", async () => {
    const j = (await (await listGET(call("/api/v1/contracts?q=" + encodeURIComponent("نگهداری")))).json()) as { items: { id: number }[]; total: number };
    expect(j.items.map((i) => i.id)).toEqual([signedId]);
    const none = (await (await listGET(call("/api/v1/contracts?q=%25%25"))).json()) as { total: number };
    expect(none.total).toBe(0);
  });
});

describe("جزئیات، لغو و PDF", () => {
  it("جزئیات شامل امضاکنندگان، خط زمانی و لینک امضا است و ایزوله می‌ماند", async () => {
    const j = (await (await detailGET(call(`/api/v1/hub/contract/${sentId}`), params(sentId))).json()) as { contract: { signers: unknown[]; timeline: { action: string }[]; signUrl: string | null; canCancel: boolean; canDownload: boolean } };
    expect(j.contract.signers.length).toBe(2);
    expect(j.contract.timeline.some((t) => t.action === "contract.viewed")).toBe(true);
    expect(j.contract.signUrl).toMatch(/\/sign\//);
    expect(j.contract.canCancel).toBe(true);
    expect(j.contract.canDownload).toBe(false);
    const other = await detailGET(new Request(`${origin}/api/v1/hub/contract/${sentId}`, { headers: { authorization: `Bearer ${otherKey}` } }), params(sentId));
    expect(other.status).toBe(404);
  });

  it("PDF فقط برای امضاشده و فقط برای همان فضای کاری", async () => {
    expect((await pdfGET(call(`/api/v1/contracts/${sentId}/pdf`), params(sentId))).status).toBe(409);
    expect((await pdfGET(new Request(`${origin}/api/v1/contracts/${signedId}/pdf`, { headers: { authorization: `Bearer ${otherKey}` } }), params(signedId))).status).toBe(404);
    const ok = await pdfGET(call(`/api/v1/contracts/${signedId}/pdf`), params(signedId));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    const buf = Buffer.from(await ok.arrayBuffer());
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("لغو: امضاشده ۴۰۹، دیگر فضا ۴۰۹/۴۰۴، در انتظار امضا موفق", async () => {
    const post = (id: number, k = key) => cancelPOST(new Request(`${origin}/api/v1/contracts/${id}/cancel`, { method: "POST", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "تست" }) }), params(id));
    expect((await post(signedId)).status).toBe(409);
    expect((await post(sentId, otherKey)).status).toBe(409);
    expect((await post(sentId)).status).toBe(200);
    const j = (await (await detailGET(call(`/api/v1/hub/contract/${sentId}`), params(sentId))).json()) as { contract: { status: string } };
    expect(j.contract.status).toBe("cancelled");
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.contractId, sentId));
    expect(rows.some((r) => r.action === "contract.cancelled")).toBe(true);
    expect(wsId).toBeGreaterThan(0);
    expect(ownerId).toBeGreaterThan(0);
  });
});

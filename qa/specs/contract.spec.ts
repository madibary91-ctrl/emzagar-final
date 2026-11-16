/**
 * ۴) تست قرارداد API (Contract Testing)
 *  الف) هر مورد رجیستری روی سرور واقعی اجرا و پاسخ با schema سنجیده می‌شود (کد، نوع محتوا، هدرها، ساختار JSON)
 *  ب) baseline: schemaها به JSON-Schema تبدیل و با qa/contracts/baseline.json مقایسه می‌شوند؛
 *     یعنی کسی نمی‌تواند بی‌صدا یک قرارداد را سست کند (به‌روزرسانی عمدی: QA_UPDATE_CONTRACTS=1)
 *  ج) پایداری: پاسخ تکراری هم‌ساختار است، خطاها هیچ‌گاه جزئیات داخلی نشت نمی‌دهند
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AUTH, expect, newApi, test } from "../lib/kit";
import { requireState } from "../lib/state";
import { REGISTRY, type ContractCase } from "../contracts/registry";

const BASELINE = path.resolve("qa/contracts/baseline.json");
const UPDATE = process.env.QA_UPDATE_CONTRACTS === "1";
const caseId = (c: ContractCase) => `${c.method} ${c.route} — ${c.name} [${c.who}]`;
const LEAK = /(\bat\s+\S+\s+\(|node_modules|SQLSTATE|syntax error at|ECONNREFUSED|stack\s*trace|\/app\/src)/i;

async function client(who: ContractCase["who"], key: string) {
  switch (who) {
    case "key": return newApi({ headers: { Authorization: `Bearer ${key}` } });
    case "badkey": return newApi({ headers: { Authorization: "Bearer not-a-valid-key" } });
    case "admin": return newApi({ auth: AUTH.admin });
    case "user": return newApi({ auth: AUTH.user });
    default: return newApi();
  }
}

test.describe("پاسخ‌ها با رجیستری قرارداد می‌خوانند", () => {
  for (const c of REGISTRY) {
    test(`[C1] ${caseId(c)}`, async () => {
      const s = requireState();
      const api = await client(c.who, s.apiKey);
      const p = typeof c.path === "function" ? c.path(s) : c.path;
      const body = typeof c.body === "function" ? (c.body as (x: typeof s) => unknown)(s) : c.body;
      const res = await api.fetch(p, { method: c.method, data: body, maxRedirects: 0, headers: body !== undefined ? { "content-type": "application/json" } : undefined });

      const want = Array.isArray(c.status) ? c.status : [c.status];
      const raw: string = c.kind === "zip" ? "" : await res.text();
      expect(want, `کد پاسخ ${res.status()} برای ${p}\n${raw.slice(0, 300)}`).toContain(res.status());

      const ct = res.headers()["content-type"] ?? "";
      if (c.kind === "json") {
        expect(ct, "نوع محتوا").toContain("application/json");
        const json = JSON.parse(raw) as unknown;
        if (c.schema) {
          const parsed = c.schema.safeParse(json);
          expect(parsed.success, parsed.success ? "" : `نقض قرارداد:\n${z.prettifyError(parsed.error)}\nپاسخ: ${raw.slice(0, 400)}`).toBe(true);
        }
      }
      if (c.kind === "zip") {
        const buf = await res.body();
        expect(buf.subarray(0, 2).toString(), "امضای ZIP").toBe("PK");
      }
      if (c.kind === "redirect") expect(res.headers()["location"], "هدر Location").toBeTruthy();
      for (const [h, re] of Object.entries(c.headers ?? {})) expect(res.headers()[h] ?? "", `هدر ${h}`).toMatch(re);
      if (res.status() >= 400 && c.kind !== "zip") expect(raw, "نشت جزئیات داخلی در خطا").not.toMatch(LEAK);
      await api.dispose();
    });
  }
});

test("[C2] baseline: هیچ قراردادی بدون ثبت تغییر نکرده است", () => {
  const current: Record<string, unknown> = {};
  for (const c of REGISTRY) if (c.schema) current[caseId(c)] = z.toJSONSchema(c.schema, { unrepresentable: "any", io: "output" });
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  if (UPDATE || !fs.existsSync(BASELINE)) {
    fs.writeFileSync(BASELINE, JSON.stringify(sorted, null, 1) + "\n");
    test.info().annotations.push({ type: "warning", description: "baseline قرارداد نوشته/به‌روز شد (در بازبینی کد ببینید)" });
    return;
  }
  const saved = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as Record<string, unknown>;
  const removed = Object.keys(saved).filter((k) => !(k in sorted));
  const changed = Object.keys(sorted).filter((k) => k in saved && JSON.stringify(saved[k]) !== JSON.stringify(sorted[k]));
  const added = Object.keys(sorted).filter((k) => !(k in saved));
  expect({ removed, changed, added }, "تغییر قرارداد؛ اگر عمدی است: QA_UPDATE_CONTRACTS=1 npm run qa:contract").toEqual({ removed: [], changed: [], added: [] });
});

test("[C3] پایداری: دو درخواست پشت‌سرهم ساختار یکسان دارند و صفحه‌بندی سازگار است", async () => {
  const s = requireState();
  const api = await newApi({ headers: { Authorization: `Bearer ${s.apiKey}` } });
  const shape = (v: unknown): unknown => (Array.isArray(v) ? [v.length ? shape(v[0]) : "empty"] : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v);
  const a = await (await api.get("/api/v1/contracts?limit=3")).json();
  const b = await (await api.get("/api/v1/contracts?limit=3")).json();
  expect(shape(a)).toEqual(shape(b));
  const p1 = (await (await api.get("/api/v1/contracts?limit=2&page=1")).json()) as { items: { id: number }[]; total: number };
  const p2 = (await (await api.get("/api/v1/contracts?limit=2&page=2")).json()) as { items: { id: number }[]; total: number };
  expect(p1.total).toBe(p2.total);
  const ids1 = new Set(p1.items.map((i) => i.id));
  expect(p2.items.every((i) => !ids1.has(i.id)), "صفحه‌ها نباید هم‌پوشانی داشته باشند").toBe(true);
  await api.dispose();
});

test("[C4] قرارداد صادرشده با API در فهرست و جزئیات همان داده را برمی‌گرداند (round-trip)", async () => {
  const s = requireState();
  const api = await newApi({ headers: { Authorization: `Bearer ${s.apiKey}`, "content-type": "application/json" } });
  const title = `قرارداد رفت‌وبرگشت ${Date.now()}`;
  const r = await api.post("/api/v1/contracts", { data: { templateId: s.templateId, title, draft: true, customer: { name: "مشتری رفت‌وبرگشت", email: "qa-roundtrip@example.com", mobile: "09125556666" } } });
  expect(r.status()).toBe(201);
  const { id } = (await r.json()) as { id: number };
  // پیش‌نویس در فهرست عمومی نمی‌آید (فقط قراردادهای منتشرشده)
  const list = (await (await api.get("/api/v1/contracts?email=qa-roundtrip@example.com")).json()) as { total: number };
  expect(list.total).toBe(0);
  const detail = (await (await api.get(`/api/v1/contracts/${id}`)).json()) as { title: string; status: string; signers: unknown[] };
  expect(detail.title).toBe(title);
  expect(detail.status).toBe("draft");
  expect(detail.signers.length).toBeGreaterThan(0);
  await api.dispose();
});

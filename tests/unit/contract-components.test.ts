import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ContractJourney, { buildJourney } from "@/components/ContractJourney";
import DiffView from "@/components/DiffView";
import ApprovalPanel from "@/components/ApprovalPanel";
import ContractMetaCard from "@/components/ContractMetaCard";
import { diffText } from "@/lib/diff";

const d = new Date("2026-01-10T10:00:00Z");

describe("کامپوننت‌های سمت سرور قرارداد", () => {
  it("مسیر قرارداد: مرحله‌ی فعلی، پایان‌های ناموفق و تأیید داخلی", () => {
    const base = { createdAt: d, publishedAt: d, signedAt: null, approvals: null };
    const signers = [
      { id: 1, label: "فروشنده", name: "الف", status: "signed", signedAt: d },
      { id: 2, label: "خریدار", name: "ب", status: "pending", signedAt: null },
    ];
    const steps = buildJourney({ ...base, status: "sent", signers });
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "done", "current", "todo"]);
    expect(buildJourney({ ...base, status: "cancelled", signers }).at(-1)).toMatchObject({ state: "failed", title: "لغو شد" });
    expect(buildJourney({ ...base, status: "draft", publishedAt: null, approvals: { total: 2, approved: 1 }, signers }).map((s) => s.key)).toContain("approval");
    const html = renderToStaticMarkup(createElement(ContractJourney, { ...base, status: "sent", signers }));
    expect(html).toContain("مسیر قرارداد");
    expect(html).toContain('aria-current="step"');
  });

  it("نمایش diff متن را escape می‌کند (بدون اجرای HTML)", () => {
    const html = renderToStaticMarkup(createElement(DiffView, { parts: diffText("سلام", "سلام <img src=x onerror=alert(1)>") }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<ins");
  });

  it("پنل تأیید داخلی و کارت برچسب/بایگانی رندر می‌شوند", () => {
    const rows = [
      { id: 1, approverId: 7, approverName: "مریم", status: "approved", note: "", decidedAt: d, createdAt: d },
      { id: 2, approverId: 8, approverName: "رضا", status: "pending", note: "", decidedAt: null, createdAt: d },
    ];
    const html = renderToStaticMarkup(
      createElement(ApprovalPanel, { contractId: 5, returnTo: "/contracts/5", rows, candidates: [{ id: 9, name: "سارا", role: "member" }], meId: 8, canWrite: true, isDraft: true }),
    );
    expect(html).toContain("۱ از ۲ تأیید");
    expect(html).toContain("تأیید می‌کنم");
    expect(html).toContain("سارا");
    expect(renderToStaticMarkup(createElement(ApprovalPanel, { contractId: 5, returnTo: "/contracts/5", rows: [], candidates: [], meId: 1, canWrite: true, isDraft: false }))).toBe("");

    const meta = renderToStaticMarkup(createElement(ContractMetaCard, { contractId: 5, tags: "سالانه,ویژه", value: 1200000, status: "signed", archivedAt: null, canWrite: true }));
    expect(meta).toContain("#سالانه");
    expect(meta).toContain("انتقال به بایگانی");
    expect(renderToStaticMarkup(createElement(ContractMetaCard, { contractId: 5, tags: "", value: null, status: "sent", archivedAt: null, canWrite: false }))).toBe("");
  });
});

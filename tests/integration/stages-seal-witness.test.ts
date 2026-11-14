import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts, contractSigners } from "@/db/schema";
import { getSigners, issueContract, currentSigners, signerTurnForUser } from "@/modules/contracts/service";
import { getOrCreateSigningLink, resolveSigningToken } from "@/modules/signing/links";
import { guestSendOtpAction, guestSignAction, guestVerifyOtpAction } from "@/modules/signing/guest-actions";
import { docFingerprint } from "@/modules/signing/fingerprint";
import { getContractPdf } from "@/modules/pdf/service";
import { verifyDocument } from "@/modules/verify/service";
import { currentStageSigners, isSignerTurn, isValidCompanyNationalId, normalizeLegal, planStages, stageJustCompleted, stageOf } from "@/modules/signing/stages";
import { ensureGuestSigner } from "@/modules/guests/service";
import { freshBrowser, makePng } from "../helpers";
import { setupWorkspace } from "../flows";

let owner: { id: number };
let wsId: number;
let n = 0;
const mobile = () => `0912${String(7000000 + n++).padStart(7, "0")}`;
const guest = async (name: string) => (await ensureGuestSigner(wsId, { name, mobile: mobile() })).userId;
const BODY = "<h2>قرارداد</h2><p>این قرارداد میان طرفین منعقد شد و برای همه‌ی آن‌ها الزام‌آور است؛ متن آزمایشی.</p>";

beforeAll(async () => {
  const s = await setupWorkspace("فضای مرحله");
  owner = s.owner;
  wsId = s.wsId;
});
beforeEach(() => freshBrowser());

/** ورود با OTP و امضا (مهمان) — مهر/پاراف اختیاری */
async function sign(signerId: number, evidence?: { seal?: string | null; initials?: string | null }) {
  freshBrowser();
  const link = (await getOrCreateSigningLink(signerId))!;
  const sent = await guestSendOtpAction(link.token);
  expect(sent.ok).toBe(true);
  expect((await guestVerifyOtpAction(link.token, sent.devCode!)).ok).toBe(true);
  return { token: link.token, res: await guestSignAction(link.token, { signature: makePng(), method: "draw", agree: true, ...evidence }) };
}

describe("موتور مرحله (ماژول خالص)", () => {
  const row = (position: number, stage: number, status = "pending") => ({ position, stage, status, userId: position });

  it("مرحله‌ی ۰ = position (سازگاری با داده‌های قدیمی و امضای ترتیبی)", () => {
    const s = [row(1, 0), row(2, 0), row(3, 0)];
    expect(s.map(stageOf)).toEqual([1, 2, 3]);
    expect(currentStageSigners(s).map((x) => x.position)).toEqual([1]);
    expect(isSignerTurn(s, s[1])).toBe(false);
  });

  it("هم‌مرحله‌ها هم‌زمان نوبت دارند و مرحله‌ی بعد منتظر می‌ماند", () => {
    const s = [row(1, 1), row(2, 1), row(3, 2)];
    expect(currentStageSigners(s).map((x) => x.position)).toEqual([1, 2]);
    expect(isSignerTurn(s, s[1])).toBe(true);
    expect(isSignerTurn(s, s[2])).toBe(false);
    s[0].status = "signed";
    expect(stageJustCompleted(s, 1)).toBe(false); // نفر دوم هنوز مانده
    s[1].status = "signed";
    expect(stageJustCompleted(s, 1)).toBe(true);
    expect(currentStageSigners(s).map((x) => x.position)).toEqual([3]);
  });

  it("برنامه‌ریزی مرحله‌ها: ترتیبی، هم‌زمان، مرحله‌ای و شاهد", () => {
    expect(planStages({ mode: "sequential", partyCount: 3, witnessCount: 0 }).parties).toEqual([1, 2, 3]);
    expect(planStages({ mode: "parallel", partyCount: 3, witnessCount: 2 })).toEqual({ parties: [1, 1, 1], witnesses: [2, 2] });
    expect(planStages({ mode: "parallel", partyCount: 2, witnessCount: 1, witnessTiming: "together" })).toEqual({ parties: [1, 1], witnesses: [1] });
    // مرحله‌های دلخواه فشرده می‌شوند (۵ و ۹ ← ۱ و ۲) و مقدار نامعتبر به ترتیب برمی‌گردد
    expect(planStages({ mode: "staged", partyStages: [9, 5, 9], partyCount: 3, witnessCount: 1 })).toEqual({ parties: [2, 1, 2], witnesses: [3] });
    expect(planStages({ mode: "staged", partyStages: [null, 0, "x" as unknown as number], partyCount: 3, witnessCount: 0 }).parties).toEqual([1, 2, 3]);
  });

  it("شناسه‌ی ملی شرکت: رقم کنترلی و ارقام فارسی", () => {
    const make = (base10: string) => {
      const d = base10.split("").map(Number);
      const dec = d[9] + 2;
      const coef = [29, 27, 23, 19, 17, 29, 27, 23, 19, 17];
      let r = coef.reduce((a, c, i) => a + (dec + d[i]) * c, 0) % 11;
      if (r === 10) r = 0;
      return base10 + r;
    };
    const ok = make("1010123456");
    expect(isValidCompanyNationalId(ok)).toBe(true);
    expect(isValidCompanyNationalId(ok.replace(/\d/g, (x) => "۰۱۲۳۴۵۶۷۸۹"[Number(x)]))).toBe(true);
    expect(isValidCompanyNationalId(ok.slice(0, 10) + ((Number(ok[10]) + 1) % 10))).toBe(false);
    expect(isValidCompanyNationalId("123")).toBe(false);
    expect(normalizeLegal({ signerType: "legal", companyName: "" }).ok).toBe(false);
    expect(normalizeLegal({ signerType: "legal", companyName: "شرکت نمونه", companyNationalId: "12345678901" }).ok).toBe(false);
    expect(normalizeLegal({ signerType: "natural" })).toEqual({ ok: true, value: { signerType: "natural", companyName: "", companyNationalId: "", signatoryTitle: "" } });
  });
});

describe("امضای هم‌زمان (موازی)", () => {
  it("همه‌ی طرف‌ها هم‌زمان لینک معتبر دارند؛ ترتیب امضا مهم نیست؛ فقط آخرین امضا قرارداد را نهایی می‌کند", async () => {
    const [a, b, c] = [await guest("طرف اول"), await guest("طرف دوم"), await guest("طرف سوم")];
    const id = await issueContract({ workspaceId: wsId, title: "هم‌زمان", bodyHtml: BODY, customerId: c, extraSigners: [{ label: "اول", userId: a }, { label: "دوم", userId: b }], signingMode: "parallel", createdBy: owner.id });
    const [contract] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(contract.signingMode).toBe("parallel");

    const signers = await getSigners(id);
    expect(signers.map((s) => s.stage)).toEqual([1, 1, 1]);
    expect(currentSigners(signers)).toHaveLength(3);
    expect(signerTurnForUser(signers, b)?.userId).toBe(b); // نفر وسط هم نوبت دارد
    for (const s of signers) expect((await resolveSigningToken((await getOrCreateSigningLink(s.id))!.token)).status).toBe("ok");

    // برعکس: سوم، دوم، اول
    for (const s of [signers[2], signers[1]]) {
      const r = await sign(s.id);
      expect(r.res.ok, r.res.error).toBe(true);
      expect(r.res.completed).toBe(false);
      expect((await db.select().from(contracts).where(eq(contracts.id, id)))[0].status).toBe("sent");
    }
    const last = await sign(signers[0].id);
    expect(last.res.ok, last.res.error).toBe(true);
    expect(last.res.completed).toBe(true);

    const [done] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(done.status).toBe("signed");
    // هش با فرمول لحظه‌ی امضا برابر است (استعلام عمومی سالم)
    expect(docFingerprint(done.bodyHtml, await getSigners(id), [])).toBe(done.docHash);
    const pdf = await getContractPdf(id);
    expect(pdf.buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("امضای ترتیبی بدون تغییر: نفر دوم پیش از اول نمی‌تواند امضا کند", async () => {
    const [a, b] = [await guest("ترتیبی اول"), await guest("ترتیبی دوم")];
    const id = await issueContract({ workspaceId: wsId, title: "ترتیبی", bodyHtml: BODY, customerId: b, extraSigners: [{ label: "اول", userId: a }], createdBy: owner.id });
    const signers = await getSigners(id);
    expect(signers.map((s) => s.stage)).toEqual([1, 2]);
    expect((await resolveSigningToken((await getOrCreateSigningLink(signers[1].id))!.token)).status).toBe("invalid");
    expect((await sign(signers[0].id)).res.ok).toBe(true);
    expect((await resolveSigningToken((await getOrCreateSigningLink(signers[1].id))!.token)).status).toBe("ok");
  });
});

describe("شاهد (Witness)", () => {
  it("شاهد پس از طرف‌ها امضا می‌کند و بدون شهادت او سند نهایی نمی‌شود", async () => {
    const [a, b, w1, w2] = [await guest("فروشنده"), await guest("خریدار"), await guest("شاهد یک"), await guest("شاهد دو")];
    const id = await issueContract({
      workspaceId: wsId,
      title: "با شاهد",
      bodyHtml: BODY,
      customerId: b,
      extraSigners: [{ label: "فروشنده", userId: a }],
      witnesses: [{ label: "شاهد اول", userId: w1 }, { userId: w2 }],
      createdBy: owner.id,
    });
    const signers = await getSigners(id);
    expect(signers.map((s) => s.role)).toEqual(["signer", "signer", "witness", "witness"]);
    expect(signers.map((s) => s.stage)).toEqual([1, 2, 3, 3]);
    expect(signers[3].label).toBe("شاهد 2");

    expect((await resolveSigningToken((await getOrCreateSigningLink(signers[2].id))!.token)).status).toBe("invalid");
    expect((await sign(signers[0].id)).res.ok).toBe(true);
    expect((await sign(signers[1].id)).res.completed).toBe(false); // طرف‌ها امضا کردند ولی شاهدها نه
    expect((await db.select().from(contracts).where(eq(contracts.id, id)))[0].status).toBe("sent");
    expect(currentSigners(await getSigners(id)).map((s) => s.role)).toEqual(["witness", "witness"]);

    expect((await sign(signers[3].id)).res.completed).toBe(false); // شاهدها هم‌زمان‌اند
    const fin = await sign(signers[2].id);
    expect(fin.res.completed).toBe(true);

    const [done] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(done.status).toBe("signed");
    const v = await verifyDocument(done.docHash!);
    expect(v.found && v.intact).toBe(true);
    expect(v.found && v.signers.filter((s) => s.witness).length).toBe(2);
    expect((await getContractPdf(id)).size).toBeGreaterThan(2000);
  });

  it("شاهد نمی‌تواند خودش طرف قرارداد باشد و تکراری نیست", async () => {
    const [a, b] = [await guest("طرف الف"), await guest("طرف ب")];
    await expect(issueContract({ workspaceId: wsId, title: "x", bodyHtml: BODY, customerId: b, extraSigners: [{ label: "الف", userId: a }], witnesses: [{ userId: a }], createdBy: owner.id })).rejects.toThrow(/شاهد/);
    const w = await guest("شاهد تکراری");
    await expect(issueContract({ workspaceId: wsId, title: "x", bodyHtml: BODY, customerId: b, witnesses: [{ userId: w }, { userId: w }], createdBy: owner.id })).rejects.toThrow(/دوبار/);
    // تراکنش برگشت خورده: قرارداد نیمه‌کاره نمی‌ماند
    const left = await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.title, "x"));
    expect(left).toHaveLength(0);
  });

  it("مرحله‌ای: دو مدیر هم‌زمان ← سپس طرف مقابل ← شاهد هم‌زمان با آخرین مرحله", async () => {
    const [m1, m2, other, w] = [await guest("مدیر یک"), await guest("مدیر دو"), await guest("طرف مقابل"), await guest("شاهد مرحله")];
    const id = await issueContract({
      workspaceId: wsId,
      title: "مرحله‌ای",
      bodyHtml: BODY,
      customerId: other,
      extraSigners: [{ label: "مدیر ۱", userId: m1, stage: 1 }, { label: "مدیر ۲", userId: m2, stage: 1 }],
      customerSpec: { stage: 2 },
      witnesses: [{ userId: w }],
      witnessTiming: "together",
      signingMode: "staged",
      createdBy: owner.id,
    });
    const s = await getSigners(id);
    expect(s.map((x) => x.stage)).toEqual([1, 1, 2, 2]);
    expect(currentSigners(s)).toHaveLength(2);
    expect((await sign(s[0].id)).res.ok).toBe(true);
    expect((await resolveSigningToken((await getOrCreateSigningLink(s[2].id))!.token)).status).toBe("invalid"); // مرحله‌ی ۱ هنوز کامل نیست
    expect((await sign(s[1].id)).res.ok).toBe(true);
    expect(currentSigners(await getSigners(id))).toHaveLength(2); // طرف مقابل + شاهد هم‌زمان
    expect((await sign(s[3].id)).res.ok).toBe(true);
    expect((await sign(s[2].id)).res.completed).toBe(true);
  });
});

describe("مهر شرکتی", () => {
  it("امضاکننده‌ی حقوقی با مهر الزامی: بدون مهر رد، با مهر ثبت و در هش سند و استعلام دیده می‌شود", async () => {
    const [seller, company] = [await guest("فروشنده حقیقی"), await guest("نماینده شرکت")];
    const id = await issueContract({
      workspaceId: wsId,
      title: "قرارداد با شرکت",
      bodyHtml: BODY,
      customerId: company,
      customerLabel: "شرکت خریدار",
      customerSpec: { signerType: "legal", companyName: "شرکت نمونه صنعت", companyNationalId: "", signatoryTitle: "مدیرعامل", sealRequired: true },
      extraSigners: [{ label: "فروشنده", userId: seller }],
      createdBy: owner.id,
    });
    const s = await getSigners(id);
    expect(s[1]).toMatchObject({ signerType: "legal", companyName: "شرکت نمونه صنعت", sealRequired: true, signatoryTitle: "مدیرعامل" });
    expect(s[0].signerType).toBe("natural");
    expect((await sign(s[0].id)).res.ok).toBe(true);

    // بدون مهر: رد می‌شود و امضا ثبت نمی‌شود
    const noSeal = await sign(s[1].id);
    expect(noSeal.res.ok).toBe(false);
    expect(noSeal.res.error).toMatch(/مهر/);
    expect((await db.select().from(contractSigners).where(eq(contractSigners.id, s[1].id)))[0].status).toBe("pending");
    // تصویر نامعتبر هم رد می‌شود
    expect((await guestSignAction(noSeal.token, { signature: makePng(), method: "draw", agree: true, seal: "data:image/png;base64,AAAA" })).ok).toBe(false);

    const ok = await guestSignAction(noSeal.token, { signature: makePng(), method: "draw", agree: true, seal: makePng() });
    expect(ok.ok, ok.error).toBe(true);
    expect(ok.completed).toBe(true);

    const row = (await getSigners(id))[1];
    expect(row.sealFile).toBeTruthy();
    expect(row.sealSha256).toMatch(/^[0-9a-f]{64}$/);
    const [done] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(docFingerprint(done.bodyHtml, await getSigners(id), [])).toBe(done.docHash);
    // تعویض مهر ← هش عوض می‌شود (مهر بخشی از اثر انگشت سند است)
    const tampered = (await getSigners(id)).map((x) => (x.id === row.id ? { ...x, sealSha256: "0".repeat(64) } : x));
    expect(docFingerprint(done.bodyHtml, tampered, [])).not.toBe(done.docHash);

    const v = await verifyDocument(done.docHash!);
    expect(v.found && v.intact).toBe(true);
    expect(v.found && v.signers[1]).toMatchObject({ sealed: true, company: "شرکت نمونه صنعت" });
    expect((await getContractPdf(id)).buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("مهر برای امضاکننده‌ی حقیقی/شاهد پذیرفته نمی‌شود (نادیده گرفته می‌شود) و اعتبار شناسه‌ی ملی هنگام صدور سنجیده می‌شود", async () => {
    const [a, w] = [await guest("حقیقی"), await guest("شاهد حقیقی")];
    const id = await issueContract({ workspaceId: wsId, title: "بدون مهر", bodyHtml: BODY, customerId: a, witnesses: [{ userId: w }], createdBy: owner.id });
    const s = await getSigners(id);
    const r1 = await sign(s[0].id, { seal: makePng() });
    expect(r1.res.ok, r1.res.error).toBe(true);
    const r2 = await sign(s[1].id, { seal: makePng() });
    expect(r2.res.ok).toBe(true);
    for (const x of await getSigners(id)) expect(x.sealFile).toBeNull();

    await expect(
      issueContract({ workspaceId: wsId, title: "شناسه بد", bodyHtml: BODY, customerId: a, customerSpec: { signerType: "legal", companyName: "شرکت بد", companyNationalId: "12345678901" }, createdBy: owner.id }),
    ).rejects.toThrow(/شناسه/);
  });
});

describe("پاراف صفحات", () => {
  it("پاراف الزامی: بدون آن رد؛ با آن ثبت، در هش و روی همه‌ی صفحات PDF (چندصفحه‌ای)", async () => {
    const [a, b] = [await guest("پاراف یک"), await guest("پاراف دو")];
    const long = `<h2>قرارداد چندصفحه‌ای</h2>${Array.from({ length: 70 }, (_, i) => `<p>ماده ${i + 1}: طرفین متعهد می‌شوند مفاد این ماده را به‌طور کامل رعایت کنند و هرگونه تغییر باید کتبی باشد.</p>`).join("")}`;
    const id = await issueContract({
      workspaceId: wsId,
      title: "پاراف",
      bodyHtml: long,
      customerId: b,
      extraSigners: [{ label: "الف", userId: a, initialsRequired: true }],
      customerSpec: { initialsRequired: true },
      createdBy: owner.id,
    });
    const s = await getSigners(id);
    expect(s.every((x) => x.initialsRequired)).toBe(true);
    const missing = await sign(s[0].id);
    expect(missing.res.ok).toBe(false);
    expect(missing.res.error).toMatch(/پاراف/);
    expect((await guestSignAction(missing.token, { signature: makePng(), method: "draw", agree: true, initials: makePng() })).ok).toBe(true);
    expect((await sign(s[1].id, { initials: makePng() })).res.completed).toBe(true);

    const rows = await getSigners(id);
    expect(rows.every((x) => !!x.initialsFile && /^[0-9a-f]{64}$/.test(x.initialsSha256 ?? ""))).toBe(true);
    const [done] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(docFingerprint(done.bodyHtml, rows, [])).toBe(done.docHash);

    const withInit = await getContractPdf(id);
    const pages = (withInit.buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    expect(withInit.size).toBeGreaterThan(5000);
  });
});

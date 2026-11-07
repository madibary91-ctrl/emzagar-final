import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contractApprovals, contracts, users } from "@/db/schema";
import { createSession } from "@/modules/auth/session";
import { adminCounts, issueContract, listTags, publishDraft, queryContracts, saveDraft, setArchived, updateContractMeta } from "@/modules/contracts/service";
import { compareRevisions, listRevisions, restoreRevision } from "@/modules/contracts/revisions";
import { decideApproval, listApprovals, requestApprovals } from "@/modules/contracts/approvals";
import { listComments, openChangeRequests } from "@/modules/contracts/negotiation";
import { guestPostCommentAction, postCommentAction, resolveCommentAction } from "@/modules/contracts/negotiation-actions";
import { getOrCreateSigningLink } from "@/modules/signing/links";
import { newClient, newContract, setupWorkspace, signAll } from "../flows";
import { freshBrowser } from "../helpers";

let owner: { id: number };
let wsId: number;

beforeAll(async () => {
  ({ owner, wsId } = await setupWorkspace("فضای همکاری"));
});
beforeEach(() => freshBrowser());

/** ورود به‌عنوان یک کاربر (کوکی نشست در محیط آزمون) */
async function loginAs(userId: number) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  await createSession(u.id, u.passwordHash);
}

const BODY = "<h2>موضوع</h2><p>مبلغ قرارداد ده میلیون تومان است و پرداخت نقدی انجام می‌شود.</p>";

async function newDraft(extra: Record<string, unknown> = {}) {
  const buyer = await newClient(wsId, "خریدار پیش‌نویس", "09123330001");
  const id = await issueContract({ workspaceId: wsId, title: "پیش‌نویس همکاری", bodyHtml: BODY, customerId: buyer.userId, createdBy: owner.id, draft: true, ...extra });
  return { id, buyer };
}

describe("نسخه‌بندی متن", () => {
  it("هر تغییر نسخه‌ی تازه می‌سازد؛ ذخیره‌ی بی‌تغییر نه؛ مقایسه و بازگردانی کار می‌کند", async () => {
    const { id } = await newDraft();
    expect((await listRevisions(id)).map((r) => [r.version, r.kind])).toEqual([[1, "initial"]]);
    await saveDraft(id, owner.id, { title: "پیش‌نویس همکاری", bodyHtml: BODY }, wsId); // بدون تغییر
    expect(await listRevisions(id)).toHaveLength(1);
    await saveDraft(id, owner.id, { title: "پیش‌نویس همکاری", bodyHtml: BODY.replace("ده", "بیست") }, wsId);
    const revs = await listRevisions(id);
    expect(revs.map((r) => r.version)).toEqual([2, 1]);
    const cmp = await compareRevisions(id, 1, 2);
    expect(cmp?.stats.changed).toBe(true);
    expect(cmp?.parts.some((p) => p.type === "del" && p.text.includes("ده"))).toBe(true);
    expect(cmp?.parts.some((p) => p.type === "add" && p.text.includes("بیست"))).toBe(true);

    await restoreRevision(id, 1, owner.id, wsId);
    const after = await listRevisions(id);
    expect(after[0]).toMatchObject({ version: 3, kind: "restore" });
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.bodyHtml).toContain("ده میلیون");
  });

  it("انتشار، نسخه‌ی publish ثبت می‌کند و بازگردانی پس از انتشار ممکن نیست", async () => {
    const { id } = await newDraft();
    await publishDraft(id, owner.id, { title: "پیش‌نویس همکاری", bodyHtml: BODY }, wsId);
    expect((await listRevisions(id))[0].kind).toBe("publish");
    await expect(restoreRevision(id, 1, owner.id, wsId)).rejects.toThrow();
  });
});

describe("تأیید داخلی", () => {
  it("انتشار تا تأیید همه مسدود است و ویرایش متن، تأیید را باطل می‌کند", async () => {
    const { id } = await newDraft();
    expect(await requestApprovals(id, wsId, [owner.id, 999999], owner.id)).toBe(1); // غیرعضو نادیده گرفته می‌شود
    await expect(publishDraft(id, owner.id, { title: "پیش‌نویس همکاری", bodyHtml: BODY }, wsId)).rejects.toThrow(/انتشار ممکن نیست/);

    await decideApproval(id, wsId, owner.id, "approved", "");
    expect((await listApprovals(id))[0].status).toBe("approved");

    // ویرایش → تأیید بی‌اعتبار
    await saveDraft(id, owner.id, { title: "پیش‌نویس همکاری", bodyHtml: BODY + "<p>بند تازه برای آزمون ابطال.</p>" }, wsId);
    expect((await listApprovals(id))[0].status).toBe("pending");
    await expect(publishDraft(id, owner.id, { title: "پیش‌نویس همکاری", bodyHtml: BODY + "<p>بند تازه برای آزمون ابطال.</p>" }, wsId)).rejects.toThrow();

    // درخواست اصلاح بدون توضیح پذیرفته نمی‌شود
    await expect(decideApproval(id, wsId, owner.id, "changes_requested", " ")).rejects.toThrow();
    await decideApproval(id, wsId, owner.id, "approved", "تأیید");
    // ویرایش همزمان با انتشار هم تأیید را باطل و انتشار را رد می‌کند
    await expect(publishDraft(id, owner.id, { title: "پیش‌نویس همکاری", bodyHtml: BODY + "<p>تغییر هم‌زمان با انتشار.</p>" }, wsId)).rejects.toThrow(/انتشار ممکن نیست/);
    await decideApproval(id, wsId, owner.id, "approved", "");
    await publishDraft(id, owner.id, { title: "پیش‌نویس همکاری", bodyHtml: BODY + "<p>تغییر هم‌زمان با انتشار.</p>" }, wsId);
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.status).toBe("sent");
    const rows = await db.select().from(contractApprovals).where(and(eq(contractApprovals.contractId, id)));
    expect(rows).toHaveLength(1);
  });
});

describe("مذاکره و پیام‌ها", () => {
  it("تیم، امضاکننده‌ی مهمان و یادداشت داخلی: دسترسی، درخواست اصلاح و بستن موضوع", async () => {
    const { id, signers } = await newContract(wsId, owner.id);
    await loginAs(owner.id);

    // پیام داخلی تیم
    expect((await postCommentAction(id, { body: "فقط برای تیم: مبلغ را با مالی چک کنید", visibility: "internal" })).ok).toBe(true);
    // پیام مشترک تیم
    expect((await postCommentAction(id, { body: "سلام، لطفاً متن را مطالعه کنید", visibility: "shared" })).ok).toBe(true);
    // امضاکننده‌ی فعلی (فروشنده) با لینک امن درخواست اصلاح می‌دهد
    const link = (await getOrCreateSigningLink(signers[0].id))!;
    const g = await guestPostCommentAction(link.token, { body: "مدت قرارداد باید ۶ ماه باشد", kind: "change_request", quote: "مدت قرارداد یک سال" });
    expect(g.ok).toBe(true);
    // توکن نامعتبر
    expect((await guestPostCommentAction("x".repeat(43), { body: "سلام سلام" })).ok).toBe(false);
    // پیام خیلی کوتاه / خیلی بلند
    expect((await guestPostCommentAction(link.token, { body: "ا" })).ok).toBe(false);
    expect((await guestPostCommentAction(link.token, { body: "ا".repeat(2001) })).ok).toBe(false);

    const forGuest = await listComments(id, { includeInternal: false });
    expect(forGuest.map((c) => c.visibility)).toEqual(["shared", "shared"]);
    expect(forGuest.some((c) => c.body.includes("مالی"))).toBe(false);
    const all = await listComments(id, { includeInternal: true });
    expect(all).toHaveLength(3);
    expect(await openChangeRequests(id)).toBe(1);

    // فیلتر «درخواست اصلاح باز» در لیست
    const withReq = await queryContracts(wsId, { openRequests: true });
    expect(withReq.rows.map((r) => r.id)).toContain(id);
    expect(withReq.rows.find((r) => r.id === id)?.openRequests).toBe(1);

    // پاسخ تیم زیر درخواست و بستن موضوع
    const req = all.find((c) => c.kind === "change_request")!;
    expect(req.quote).toBe("مدت قرارداد یک سال");
    expect((await postCommentAction(id, { body: "حتماً اصلاح می‌کنیم", parentId: req.id })).ok).toBe(true);
    expect((await resolveCommentAction(id, req.id, true)).ok).toBe(true);
    expect(await openChangeRequests(id)).toBe(0);
    expect((await queryContracts(wsId, { openRequests: true })).rows.map((r) => r.id)).not.toContain(id);
  });

  it("در پیش‌نویس فقط یادداشت داخلی ثبت می‌شود و کاربر بیرونی دسترسی ندارد", async () => {
    const { id } = await newDraft();
    await loginAs(owner.id);
    expect((await postCommentAction(id, { body: "پیام مشترک در پیش‌نویس", visibility: "shared" })).ok).toBe(true);
    const rows = await listComments(id, { includeInternal: true });
    expect(rows[0].visibility).toBe("internal");
    expect(await listComments(id, { includeInternal: false })).toHaveLength(0);

    const stranger = await newClient(wsId, "غریبه", "09124440001");
    await loginAs(stranger.userId);
    expect((await postCommentAction(id, { body: "نباید ثبت شود" })).ok).toBe(false);
  });
});

describe("برچسب، ارزش و بایگانی", () => {
  it("بایگانی فقط برای قرارداد پایان‌یافته؛ لیست پیش‌فرض بایگانی را نشان نمی‌دهد", async () => {
    const { id } = await newContract(wsId, owner.id, { tags: "سالانه، ویژه ،سالانه", contractValue: 5_000_000 });
    expect(await setArchived(id, wsId, owner.id, true)).toBe(false); // هنوز در جریان است
    await signAll(id);
    const before = await adminCounts(wsId);
    expect(await setArchived(id, wsId, owner.id, true)).toBe(true);
    expect(await setArchived(id, wsId, owner.id, true)).toBe(false); // دوباره نه
    const after = await adminCounts(wsId);
    expect(after.archived).toBe(before.archived + 1);
    expect(after.active).toBe(before.active - 1);
    expect(after.all).toBe(before.all);

    expect((await queryContracts(wsId, {})).rows.map((r) => r.id)).not.toContain(id);
    const arch = await queryContracts(wsId, { archived: true });
    const row = arch.rows.find((r) => r.id === id)!;
    expect(row.tags).toBe("سالانه,ویژه");
    expect(row.contractValue).toBe(5_000_000);

    // فیلتر برچسب و جستجو در برچسب
    expect((await queryContracts(wsId, { archived: true, tag: "ویژه" })).rows.map((r) => r.id)).toContain(id);
    expect((await queryContracts(wsId, { archived: true, tag: "ناموجود" })).rows).toHaveLength(0);
    expect((await queryContracts(wsId, { archived: true, q: "سالانه" })).rows.map((r) => r.id)).toContain(id);
    expect((await listTags(wsId)).map((t) => t.tag)).toContain("سالانه");

    expect(await updateContractMeta(id, wsId, owner.id, { tags: "جدید", value: 0 })).toBe(true);
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c).toMatchObject({ tags: "جدید", contractValue: null });

    expect(await setArchived(id, wsId, owner.id, false)).toBe(true);
    expect((await queryContracts(wsId, {})).rows.map((r) => r.id)).toContain(id);
  });
});

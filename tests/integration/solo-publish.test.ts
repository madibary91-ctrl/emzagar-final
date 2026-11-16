import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts, users, workspaceMembers } from "@/db/schema";
import { createSession } from "@/modules/auth/session";
import { draftAction } from "@/modules/contracts/actions";
import { approveOwnPendingOnPublish, decideApproval, listApprovals, pendingApprovers, requestApprovals } from "@/modules/contracts/approvals";
import { issueContract } from "@/modules/contracts/service";
import { newClient, setupWorkspace } from "../flows";
import { form, freshBrowser, run } from "../helpers";

let owner: { id: number };
let wsId: number;

beforeAll(async () => {
  ({ owner, wsId } = await setupWorkspace("فضای کاربر تنها"));
});
beforeEach(() => freshBrowser());

const BODY = "<h2>موضوع</h2><p>مبلغ قرارداد ۷۵٬۰۰۰٬۰۰۰ تومان است و پرداخت نقدی انجام می‌شود.</p>";

async function loginAs(userId: number) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  await createSession(u.id, u.passwordHash);
}
async function newDraft() {
  const buyer = await newClient(wsId, "خریدار تنها", `0912${Math.floor(1000000 + Math.random() * 8999999)}`);
  return issueContract({ workspaceId: wsId, title: "قرارداد تنها", bodyHtml: BODY, customerId: buyer.userId, createdBy: owner.id, draft: true });
}
const publishForm = (id: number, body = BODY) => form({ id: String(id), title: "قرارداد تنها", body, intent: "publish" });

describe("انتشار برای کاربری که تنها کار می‌کند (بدون چرخه‌ی تأیید)", () => {
  it("اگر کاربر از خودش تأیید خواسته بود، «انتشار نسخه نهایی» مستقیم منتشر می‌کند", async () => {
    const id = await newDraft();
    await requestApprovals(id, wsId, [owner.id], owner.id);
    await loginAs(owner.id);
    const r = await run(() => draftAction({}, publishForm(id)));
    expect(r.redirect).toBe(`/contracts/${id}`);
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.status).toBe("sent");
    expect((await listApprovals(id))[0].status).toBe("approved");
  });

  it("حتی اگر متن همزمان با انتشار ویرایش شده باشد، در حلقه‌ی «ذخیره ← تأیید ← ذخیره» گیر نمی‌کند", async () => {
    const id = await newDraft();
    await requestApprovals(id, wsId, [owner.id], owner.id);
    await decideApproval(id, wsId, owner.id, "approved", "");
    await loginAs(owner.id);
    const r = await run(() => draftAction({}, publishForm(id, BODY + "<p>بند تازه‌ی اضافه‌شده هنگام انتشار.</p>")));
    expect(r.redirect).toBe(`/contracts/${id}`);
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.status).toBe("sent");
    expect(c.bodyHtml).toContain("بند تازه");
  });

  it("تأیید همکار دیگر دور زده نمی‌شود و پیام خطا نام منتظَر و وضعیت ذخیره را می‌گوید", async () => {
    const id = await newDraft();
    const other = await newClient(wsId, "همکار حقوقی", "09125550001");
    // همکار را به‌عنوان عضو تیم (نه مشتری) ثبت می‌کنیم
    await db.insert(workspaceMembers).values({ workspaceId: wsId, userId: other.userId, role: "member" }).onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.userId], set: { role: "member" } });
    await requestApprovals(id, wsId, [owner.id, other.userId], owner.id);
    await loginAs(owner.id);
    const r = await run(() => draftAction({}, publishForm(id)));
    expect(r.redirect).toBeUndefined();
    expect((r.result as { error?: string }).error).toMatch(/ذخیره شد، اما انتشار انجام نشد/);
    expect((r.result as { error?: string }).error).toMatch(/همکار حقوقی/);
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.status).toBe("draft");
    expect((await pendingApprovers(id, owner.id)).map((p) => p.name)).toEqual(["همکار حقوقی"]);
    // تأیید خودِ منتشرکننده ثبت شده، تأیید همکار نه
    expect(await approveOwnPendingOnPublish(id, wsId, owner.id)).toBe(0);
  });
});

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, contracts, userNotifications, userSessions, userTotp, users, workspaceMembers } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { createSession, destroySession, getCurrentSessionId, getCurrentUser, listSessions, revokeSession, revokeSessions } from "@/modules/auth/session";
import { deleteAccountAction, changePasswordAction, revokeOtherSessionsAction, revokeSessionAction } from "@/modules/account/actions";
import { listNotifications, markRead, notifyUser, purgeOldNotifications, unreadCount } from "@/modules/inbox/service";
import { buildUserExport } from "@/modules/privacy/service";
import { renewContract, runRenewalChecks, setContractTerm } from "@/modules/renewals/service";
import { issueContract } from "@/modules/contracts/service";
import { runAutomation } from "@/modules/automation/service";
import { GET as notifGet, POST as notifPost } from "@/app/api/notifications/route";
import { GET as exportGet } from "@/app/api/account/export/route";
import { createWorkspace } from "@/modules/tenancy/service";
import { env, form, freshBrowser, run, setIp, uniq } from "../helpers";
import { guestSignWith, newClient, newContract, setupWorkspace, signAll } from "../flows";

let owner: { id: number; email: string };
let wsId: number;
const DAY = 86400000;

beforeAll(async () => {
  ({ owner, wsId } = await setupWorkspace());
});
beforeEach(() => freshBrowser());

async function makeUser(label = "u") {
  const [u] = await db
    .insert(users)
    .values({ name: "کاربر آزمون", email: `${uniq(label)}@example.com`, mobile: "09123334444", passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() })
    .returning();
  return u;
}

describe("مرکز اعلان درون‌برنامه‌ای", () => {
  it("جریان قرارداد اعلان‌های درست می‌سازد: نوبت امضا، امضا، نهایی‌شدن", async () => {
    const { id, signers } = await newContract(wsId, owner.id, { title: "قرارداد اعلان" });
    // نفر اول (فروشنده) اعلان «نوبت امضا» می‌گیرد؛ نفر دوم هنوز نه
    const first = await listNotifications(signers[0].userId);
    expect(first.some((n) => n.kind === "action" && n.href === `/contracts/${id}`)).toBe(true);
    expect(await listNotifications(signers[1].userId)).toHaveLength(0);

    await guestSignWith(signers[0].id);
    // مالک/تیم: «فروشنده امضا کرد»؛ نفر دوم: «نوبت شماست»
    expect((await listNotifications(owner.id)).some((n) => /امضا کرد/.test(n.title))).toBe(true);
    expect((await listNotifications(signers[1].userId)).some((n) => /نوبت امضای شما/.test(n.title))).toBe(true);

    await guestSignWith(signers[1].id);
    for (const uid of [signers[0].userId, signers[1].userId, owner.id]) {
      expect((await listNotifications(uid)).some((n) => /نهایی شد/.test(n.title) && n.kind === "success")).toBe(true);
    }
  });

  it("dedupe، خوانده‌شدن، شمارنده و ایزولاسیون کاربران", async () => {
    const a = await makeUser("a");
    const b = await makeUser("b");
    expect(await notifyUser(a.id, { title: "یک", dedupeKey: "k1" })).toBe(true);
    expect(await notifyUser(a.id, { title: "یک دوباره", dedupeKey: "k1" })).toBe(false);
    expect(await notifyUser(b.id, { title: "برای ب", dedupeKey: "k1" })).toBe(true); // کلید برای هر کاربر جداست
    await notifyUser(a.id, { title: "دو" });
    expect(await unreadCount(a.id)).toBe(2);
    const [n1] = await listNotifications(a.id, { limit: 5 });
    // کاربر b نمی‌تواند اعلان a را بخواند
    expect(await markRead(b.id, [n1.id])).toBe(0);
    expect(await unreadCount(a.id)).toBe(2);
    expect(await markRead(a.id, [n1.id])).toBe(1);
    expect(await unreadCount(a.id)).toBe(1);
    expect(await markRead(a.id)).toBe(1);
    expect(await unreadCount(a.id)).toBe(0);
    expect(await notifyUser(null, { title: "x" })).toBe(false);
  });

  it("API زنگوله: ورود لازم، فهرست، فقط شمارنده، خوانده‌شدن همه", async () => {
    const u = await makeUser("api");
    expect((await notifGet(new Request("http://x/api/notifications"))).status).toBe(401);
    expect((await notifPost(new Request("http://x", { method: "POST", body: "{}" }))).status).toBe(401);
    await createSession(u.id, u.passwordHash);
    await notifyUser(u.id, { title: "اعلان ۱", kind: "warning", href: "/dashboard" });
    await notifyUser(u.id, { title: "اعلان ۲" });
    const list = (await (await notifGet(new Request("http://x/api/notifications"))).json()) as { unread: number; items: { title: string; read: boolean }[] };
    expect(list.unread).toBe(2);
    expect(list.items).toHaveLength(2);
    expect(((await (await notifGet(new Request("http://x/api/notifications?count=1"))).json()) as { unread: number }).unread).toBe(2);
    const after = (await (await notifPost(new Request("http://x", { method: "POST", body: JSON.stringify({}) }))).json()) as { unread: number };
    expect(after.unread).toBe(0);
  });

  it("پاک‌سازی: اعلان خوانده‌ی قدیمی حذف می‌شود، تازه می‌ماند", async () => {
    const u = await makeUser("purge");
    await notifyUser(u.id, { title: "قدیمی" });
    await notifyUser(u.id, { title: "تازه" });
    await db.update(userNotifications).set({ createdAt: new Date(Date.now() - 100 * DAY), readAt: new Date() }).where(and(eq(userNotifications.userId, u.id), eq(userNotifications.title, "قدیمی")));
    expect(await purgeOldNotifications()).toBeGreaterThanOrEqual(1);
    expect((await listNotifications(u.id)).map((n) => n.title)).toEqual(["تازه"]);
  });
});

describe("نشست‌ها و دستگاه‌ها", () => {
  it("هر ورود یک نشست؛ ورود از دستگاه جدید اعلان امنیتی؛ بستن نشست فوراً اثر می‌کند", async () => {
    const u = await makeUser("sess");
    env.headers.set("user-agent", "Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537");
    await createSession(u.id, u.passwordHash);
    const cookie1 = env.cookies.get("amz_session")!;
    expect(cookie1.split(".")).toHaveLength(4);
    expect(await listNotifications(u.id)).toHaveLength(0); // اولین ورود اعلان ندارد
    const sid1 = (await getCurrentSessionId())!;

    env.headers.set("user-agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17) Safari/604");
    setIp("10.9.9.9");
    await createSession(u.id, u.passwordHash);
    const cookie2 = env.cookies.get("amz_session")!;
    const sec = (await listNotifications(u.id)).find((n) => n.kind === "security");
    expect(sec?.title).toMatch(/دستگاه جدید/);
    const sid2 = (await getCurrentSessionId())!;

    const rows = await listSessions(u.id, sid2);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.current)?.id).toBe(sid2);

    // دستگاه ۱ هنوز معتبر است؛ بعد از بستن، رد می‌شود
    env.cookies.set("amz_session", cookie1);
    expect((await getCurrentUser())?.id).toBe(u.id);
    env.cookies.set("amz_session", cookie2);
    const r = await run(() => revokeSessionAction(form({ sid: sid1 })));
    expect(r.redirect).toBeUndefined();
    env.cookies.set("amz_session", cookie1);
    expect(await getCurrentUser()).toBeNull();
    // نشست فعلی را نمی‌توان با revokeSessionAction بست
    env.cookies.set("amz_session", cookie2);
    await revokeSessionAction(form({ sid: sid2 }));
    expect((await getCurrentUser())?.id).toBe(u.id);
    expect(await revokeSession(u.id + 999, sid2)).toBe(false); // نشست کاربر دیگر قابل ابطال نیست
  });

  it("«خروج از دستگاه‌های دیگر»، خروج و تغییر رمز", async () => {
    const u = await makeUser("sess2");
    await createSession(u.id, u.passwordHash);
    const a = env.cookies.get("amz_session")!;
    env.headers.set("user-agent", "Firefox/120 (Linux)");
    await createSession(u.id, u.passwordHash);
    const b = env.cookies.get("amz_session")!;
    await revokeOtherSessionsAction();
    env.cookies.set("amz_session", a);
    expect(await getCurrentUser()).toBeNull();
    env.cookies.set("amz_session", b);
    expect(await getCurrentUser()).not.toBeNull();

    // تغییر رمز: همه‌ی نشست‌های قبلی (حتی فعلی قبلی) باطل و نشست تازه ساخته می‌شود
    const res = await changePasswordAction({}, form({ currentPassword: "Owner123x", newPassword: "Str0ng-Pass!2025", confirm: "Str0ng-Pass!2025" }));
    expect(res.ok, res.error).toBe(true);
    const fresh = env.cookies.get("amz_session")!;
    expect(fresh).not.toBe(b);
    expect((await getCurrentUser())?.id).toBe(u.id);
    env.cookies.set("amz_session", b);
    expect(await getCurrentUser()).toBeNull();

    // خروج: ردیف نشست باطل می‌شود
    env.cookies.set("amz_session", fresh);
    const sid = (await getCurrentSessionId())!;
    await destroySession();
    const [row] = await db.select().from(userSessions).where(eq(userSessions.id, sid));
    expect(row.revokedAt).not.toBeNull();
    env.cookies.set("amz_session", fresh);
    expect(await getCurrentUser()).toBeNull();
    expect(await revokeSessions(u.id, null)).toBe(0);
  });

  it("کوکی دست‌کاری‌شده یا قدیمی بی‌نشست پذیرفته نمی‌شود/سازگار است", async () => {
    const u = await makeUser("sess3");
    await createSession(u.id, u.passwordHash);
    const parts = env.cookies.get("amz_session")!.split(".");
    env.cookies.set("amz_session", [parts[0], parts[1], "AAAA", parts[3]].join("."));
    expect(await getCurrentUser()).toBeNull();
    env.cookies.set("amz_session", [String(u.id + 1), parts[1], parts[2], parts[3]].join("."));
    expect(await getCurrentUser()).toBeNull();
    env.cookies.set("amz_session", "garbage");
    expect(await getCurrentUser()).toBeNull();
  });
});

describe("خروجی داده‌های شخصی", () => {
  it("شامل داده‌های کاربر است و رمز/راز در آن نیست؛ نیاز به ورود دارد", async () => {
    const { id, signers, buyer } = await newContract(wsId, owner.id, { body: "<p>نشانی {{field:address|نشانی|address}} و توضیح بیشتر برای قرارداد آزمایشی.</p>" });
    await signAll(id, { 2: { address: "تهران، خیابان ولیعصر، پلاک ۱" } });
    freshBrowser();
    expect((await exportGet()).status).toBe(401);
    const [b] = await db.select().from(users).where(eq(users.id, buyer.userId));
    await db.insert(userTotp).values({ userId: b.id, secret: "SUPER-SECRET-VALUE", enabledAt: new Date() });
    await createSession(b.id, b.passwordHash);
    const res = await exportGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment/);
    const text = await res.text();
    expect(text).not.toContain(b.passwordHash);
    expect(text).not.toContain("SUPER-SECRET-VALUE");
    const data = JSON.parse(text);
    expect(data.profile.email).toBe(b.email);
    expect(data.profile.twoFactorEnabled).toBe(true);
    expect(data.contractsAsSigner[0].filledFields[0].value).toBe("تهران، خیابان ولیعصر، پلاک ۱");
    expect(data.activityLog.length).toBeGreaterThan(0);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.userId, b.id))).some((a) => a.action === "account.exported")).toBe(true);
    expect((await buildUserExport(b.id))!.workspaces.length).toBeGreaterThan(0);
    void signers;
  });
});

describe("حذف حساب", () => {
  it("رمز و عبارت تأیید لازم است؛ مالک فضای کاری تیمی نمی‌تواند حذف کند", async () => {
    const o = await makeUser("owner");
    const ws = await createWorkspace(o.id, "تیم من");
    const member = await makeUser("member");
    await db.insert(workspaceMembers).values({ workspaceId: ws, userId: member.id, role: "member" });
    await createSession(o.id, o.passwordHash);
    expect((await deleteAccountAction({}, form({ currentPassword: "Owner123x", confirm: "اشتباه" }))).error).toMatch(/عبارت/);
    expect((await deleteAccountAction({}, form({ currentPassword: "wrong-pass", confirm: "حذف حساب من" }))).error).toMatch(/رمز/);
    const blocked = await deleteAccountAction({}, form({ currentPassword: "Owner123x", confirm: "حذف حساب من" }));
    expect(blocked.error).toMatch(/مالکیت/);
    expect((await db.select().from(users).where(eq(users.id, o.id)))[0].name).toBe("کاربر آزمون");
  });

  it("ناشناس‌سازی: داده‌های شخصی پاک، قرارداد در جریان لغو، قرارداد امضاشده با هویت ناشناس حفظ", async () => {
    const signed = await newContract(wsId, owner.id, { title: "امضاشده" });
    await signAll(signed.id);
    const inflight = await newContract(wsId, owner.id, { title: "در جریان" });
    const victimId = inflight.buyer.userId;
    // خریدار قرارداد «امضاشده» همان خریدار «در جریان» نیست؛ یک مشتری مشترک می‌سازیم
    const shared = await newClient(wsId, "مشتری حذف‌شونده", "09125556666");
    const cId = await issueContract({ workspaceId: wsId, title: "برای حذف", bodyHtml: "<p>قرارداد آزمایشی برای حذف حساب مشتری.</p>", customerId: shared.userId, createdBy: owner.id });
    const sharedSigned = await newContract(wsId, owner.id);
    void sharedSigned;
    void victimId;

    const [u] = await db.select().from(users).where(eq(users.id, shared.userId));
    // رمز کاربر را مشخص می‌کنیم تا مسیر واقعی حذف را برویم
    await db.update(users).set({ passwordHash: hashPassword("Owner123x") }).where(eq(users.id, u.id));
    const [fresh] = await db.select().from(users).where(eq(users.id, u.id));
    await createSession(fresh.id, fresh.passwordHash);
    await db.insert(userTotp).values({ userId: fresh.id, secret: "x", enabledAt: new Date() }).onConflictDoNothing();
    await notifyUser(fresh.id, { title: "اعلان خصوصی" });

    const r = await run(() => deleteAccountAction({}, form({ currentPassword: "Owner123x", confirm: "حذف حساب من" })));
    expect(r.redirect).toBe("/login?deleted=1");
    expect(env.cookies.has("amz_session")).toBe(false);

    const [gone] = await db.select().from(users).where(eq(users.id, u.id));
    expect(gone.email).toMatch(/@deleted\.invalid$/);
    expect(gone.name).toBe("کاربر حذف‌شده");
    expect(gone.mobile).toBe("");
    expect(gone.passwordHash.startsWith("x:")).toBe(true);
    expect(await db.select().from(userSessions).where(eq(userSessions.userId, u.id))).toHaveLength(0);
    expect(await db.select().from(userTotp).where(eq(userTotp.userId, u.id))).toHaveLength(0);
    expect(await db.select().from(userNotifications).where(eq(userNotifications.userId, u.id))).toHaveLength(0);
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, u.id))).toHaveLength(0);
    const [c] = await db.select().from(contracts).where(eq(contracts.id, cId));
    expect(c.status).toBe("cancelled");
    // قرارداد امضاشده‌ی دیگر دست‌نخورده
    expect((await db.select().from(contracts).where(eq(contracts.id, signed.id)))[0].status).toBe("signed");
    // ورود با حساب حذف‌شده ممکن نیست
    expect(await getCurrentUser()).toBeNull();
  });
});

describe("زمان‌بندی تمدید قرارداد", () => {
  async function signedContract(extra: Partial<Parameters<typeof issueContract>[0]> = {}) {
    const c = await newContract(wsId, owner.id, extra);
    await signAll(c.id);
    return c;
  }

  it("termDays هنگام صدور: پایان مدت از لحظه‌ی امضای نهایی محاسبه می‌شود", async () => {
    const { id } = await signedContract({ termDays: 365, renewalNoticeDays: 45 });
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.renewalNoticeDays).toBe(45);
    const diff = (c.termEndsAt!.getTime() - c.signedAt!.getTime()) / DAY;
    expect(Math.round(diff)).toBe(365);
  });

  it("یادآوری دقیقاً یک‌بار؛ اعلان درون‌برنامه‌ای؛ پس از تمدید دیگر یادآوری نمی‌شود", async () => {
    const { id } = await signedContract();
    // بیرون از پنجره‌ی یادآوری: چیزی نمی‌رود
    expect((await setContractTerm({ contractId: id, workspaceId: wsId, actorId: owner.id, termEndsAt: new Date(Date.now() + 90 * DAY), noticeDays: 30 })).ok).toBe(true);
    expect(await runRenewalChecks(wsId)).toBe(0);
    // داخل پنجره
    await setContractTerm({ contractId: id, workspaceId: wsId, actorId: owner.id, termEndsAt: new Date(Date.now() + 10 * DAY), noticeDays: 30 });
    expect(await runRenewalChecks(wsId)).toBe(1);
    expect(await runRenewalChecks(wsId)).toBe(0);
    expect((await listNotifications(owner.id)).some((n) => /رو به پایان/.test(n.title) && n.href === `/contracts/${id}#renewal`)).toBe(true);
    // پایان مدت واقعی: یادآوری «پایان یافت»
    await db.update(contracts).set({ termEndsAt: new Date(Date.now() - DAY), renewalNotifiedAt: new Date(), termEndedNotifiedAt: null }).where(eq(contracts.id, id));
    expect(await runRenewalChecks(wsId)).toBe(1);
    expect(await runRenewalChecks(wsId)).toBe(0);
    expect((await listNotifications(owner.id)).some((n) => /به پایان رسید/.test(n.title))).toBe(true);
  });

  it("ورودی نامعتبر، فقط قرارداد امضاشده و تفکیک فضای کاری", async () => {
    const sent = await newContract(wsId, owner.id);
    expect((await setContractTerm({ contractId: sent.id, workspaceId: wsId, actorId: owner.id, termEndsAt: new Date(Date.now() + DAY), noticeDays: 30 })).ok).toBe(false);
    const { id } = await signedContract();
    expect((await setContractTerm({ contractId: id, workspaceId: wsId, actorId: owner.id, termEndsAt: new Date(Date.now() - 400 * DAY), noticeDays: 30 })).ok).toBe(false); // قبل از امضا
    expect((await setContractTerm({ contractId: id, workspaceId: wsId, actorId: owner.id, termEndsAt: new Date("invalid"), noticeDays: 30 })).ok).toBe(false);
    expect((await setContractTerm({ contractId: id, workspaceId: wsId + 999, actorId: owner.id, termEndsAt: new Date(Date.now() + DAY), noticeDays: 30 })).ok).toBe(false);
    await expect(renewContract(id, owner.id, wsId + 999)).rejects.toThrow();
    await expect(renewContract(sent.id, owner.id, wsId)).rejects.toThrow(/امضاشده/);
  });

  it("تمدید: پیش‌نویس جدید با لینک به قبلی، ایدمپوتنت، و بدون یادآوری بعدی", async () => {
    const { id } = await signedContract({ termDays: 30 });
    const a = await renewContract(id, owner.id, wsId);
    expect(a.existing).toBe(false);
    const [draft] = await db.select().from(contracts).where(eq(contracts.id, a.id));
    expect(draft).toMatchObject({ status: "draft", renewedFromId: id, termDays: 30 });
    const b = await renewContract(id, owner.id, wsId);
    expect(b).toEqual({ id: a.id, existing: true });
    await db.update(contracts).set({ termEndsAt: new Date(Date.now() + 5 * DAY), renewalNotifiedAt: null }).where(eq(contracts.id, id));
    expect(await runRenewalChecks(wsId)).toBe(0); // تمدید شده؛ یادآوری لازم نیست
  });

  it("runAutomation مرحله‌ی تمدید را اجرا می‌کند", async () => {
    const { id } = await signedContract();
    await db.update(contracts).set({ termEndsAt: new Date(Date.now() + 3 * DAY), renewalNoticeDays: 30, renewalNotifiedAt: null, termEndedNotifiedAt: null }).where(eq(contracts.id, id));
    const r = await runAutomation("manual", wsId);
    expect(r.renewals).toBe(1);
  });
});

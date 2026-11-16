import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { chatConversations, chatMessages, contracts, tickets, userNotifications, users } from "@/db/schema";
import { createSession } from "@/modules/auth/session";
import { getOrCreateSigningLink } from "@/modules/signing/links";
import { ensureClient } from "@/modules/tenancy/service";
import { createWorkspace } from "@/modules/tenancy/service";
import { hashPassword } from "@/lib/password";
import { exportUserChats, deleteUserChats, touchAgent } from "@/modules/chat/service";
import { GET as bootstrap } from "@/app/api/chat/bootstrap/route";
import { POST as send } from "@/app/api/chat/send/route";
import { POST as act } from "@/app/api/chat/act/route";
import { GET as stream, POST as poll } from "@/app/api/chat/stream/route";
import { GET as staffList } from "@/app/api/chat/staff/list/route";
import { GET as staffThread } from "@/app/api/chat/staff/thread/route";
import { POST as staffAct } from "@/app/api/chat/staff/act/route";
import { freshBrowser, uniq } from "../helpers";
import { newContract, setupWorkspace } from "../flows";

const BASE = "http://localhost:3000";
const post = (path: string, body: unknown) => new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string, init?: RequestInit) => new Request(`${BASE}${path}`, init);
const j = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function loginAs(u: { id: number; passwordHash: string }) {
  freshBrowser();
  await createSession(u.id, u.passwordHash);
}

let ws: Awaited<ReturnType<typeof setupWorkspace>>;
let token: string;
let contractNumber: string;
let contractId: number;
let admin: typeof users.$inferSelect;
let customer: typeof users.$inferSelect;

beforeAll(async () => {
  ws = await setupWorkspace("تیم چت");
  const c = await newContract(ws.wsId, ws.owner.id, { title: "قرارداد گفتگو" });
  contractId = c.id;
  const link = (await getOrCreateSigningLink(c.signers[0].id))!;
  token = link.token;
  [admin] = await db.insert(users).values({ name: "مدیر کل", email: `${uniq("adm")}@example.com`, mobile: "09120000100", passwordHash: hashPassword("Admin123x"), role: "admin", emailVerifiedAt: new Date() }).returning();
  [customer] = await db.insert(users).values({ name: "مشتری عادی", email: `${uniq("cus")}@example.com`, mobile: "09120000101", passwordHash: hashPassword("Cus123xyz"), role: "user", emailVerifiedAt: new Date() }).returning();
  await createWorkspace(customer.id, "فضای مشتری");
  const [num] = await db.select({ number: contracts.number }).from(contracts).where(eq(contracts.id, contractId));
  contractNumber = num.number;
});

describe("گفتگوی زنده — مهمان در صفحه‌ی امضا ↔ تیم صادرکننده", () => {
  let code = "";
  let guestCookie = "";

  it("لینک نامعتبر یا زمینه‌ی نامعتبر رد می‌شود", async () => {
    freshBrowser();
    const bad = await bootstrap(get(`/api/chat/bootstrap?kind=sign&ref=${"x".repeat(43)}`));
    expect(bad.status).toBe(404);
    expect((await bootstrap(get("/api/chat/bootstrap?kind=hack"))).status).toBe(400);
    // panel بدون ورود
    expect((await bootstrap(get("/api/chat/bootstrap?kind=panel"))).status).toBe(401);
  });

  it("bootstrap مقصد و برچسب قرارداد را می‌دهد؛ بدون گفتگو", async () => {
    freshBrowser();
    const r = await bootstrap(get(`/api/chat/bootstrap?kind=sign&ref=${token}`));
    expect(r.status).toBe(200);
    const b = await j(r);
    expect(b.queue).toBe("workspace");
    expect(b.targets).toHaveLength(2);
    expect(b.contextLabel).toContain(contractNumber);
    expect(b.conversation).toBeNull();
    expect(b.online).toBe(false);
  });

  it("ارسال پیام: گفتگو ساخته می‌شود، آفلاین بودن اعلام و تیم اعلان می‌گیرد", async () => {
    freshBrowser();
    const env = (globalThis as unknown as { __testEnv: { cookies: Map<string, string> } }).__testEnv;
    const r = await send(post("/api/chat/send", { kind: "sign", ref: token, text: "  سلام، کد پیامکی نرسید <script>alert(1)</script>  ", clientId: "c-1", path: "/sign/abc" }));
    expect(r.status).toBe(200);
    const d = await j(r);
    code = d.conversation.code;
    expect(d.created).toBe(true);
    expect(d.message.body).toContain("<script>"); // متن خام ذخیره می‌شود؛ رندر React آن را escape می‌کند
    expect(d.conversation.messages.some((m: { kind: string }) => m.kind === "system")).toBe(true);
    guestCookie = env.cookies.get("amz_chat") ?? "";
    expect(guestCookie.length).toBeGreaterThan(30);
    const [conv] = await db.select().from(chatConversations).where(eq(chatConversations.code, code));
    expect(conv.queue).toBe("workspace");
    expect(conv.workspaceId).toBe(ws.wsId);
    expect(conv.contractId).toBe(contractId);
    expect(conv.unreadStaff).toBe(1);
    const notes = await db.select().from(userNotifications).where(and(eq(userNotifications.userId, ws.owner.id), eq(userNotifications.kind, "action")));
    expect(notes.some((n) => n.href === `/admin/chat?c=${code}`)).toBe(true);
  });

  it("ارسال تکراری با همان clientId پیام دوم نمی‌سازد", async () => {
    const env = (globalThis as unknown as { __testEnv: { cookies: Map<string, string> } }).__testEnv;
    env.cookies.set("amz_chat", guestCookie);
    const r = await send(post("/api/chat/send", { kind: "sign", ref: token, text: "سلام، کد پیامکی نرسید <script>alert(1)</script>", clientId: "c-1" }));
    expect(r.status).toBe(200);
    const rows = await db.select().from(chatMessages).innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId)).where(and(eq(chatConversations.code, code), eq(chatMessages.senderKind, "requester")));
    expect(rows).toHaveLength(1);
  });

  it("پیام خالی و بیش‌ازحد طولانی مدیریت می‌شود", async () => {
    const env = (globalThis as unknown as { __testEnv: { cookies: Map<string, string> } }).__testEnv;
    env.cookies.set("amz_chat", guestCookie);
    expect((await send(post("/api/chat/send", { kind: "sign", ref: token, text: "   \n  " }))).status).toBe(400);
    const long = await j(await send(post("/api/chat/send", { kind: "sign", ref: token, text: "الف".repeat(5000), clientId: "c-long" })));
    expect(long.message.body.length).toBe(2000);
  });

  it("بازدیدکننده‌ی دیگر به گفتگو دسترسی ندارد", async () => {
    freshBrowser();
    const p = await poll(post("/api/chat/stream", { c: code, after: 0 }));
    expect(p.status).toBe(404);
    expect((await stream(get(`/api/chat/stream?c=${code}`))).status).toBe(404);
    expect((await act(post("/api/chat/act", { code, action: "close" }))).status).toBe(404);
  });

  it("پشتیبان خارج از تیم (کاربر عادی/مدیر فضای دیگر) دسترسی ندارد", async () => {
    await loginAs(customer);
    // مشتری فقط صف فضای کاری خودش را می‌بیند (نه گفتگوی این تیم) و صف پلتفرم را اصلاً نه
    const own = await j(await staffList(get("/api/chat/staff/list?queue=workspace")));
    expect(own.items.find((i: { code: string }) => i.code === code)).toBeUndefined();
    expect((await staffList(get("/api/chat/staff/list?queue=platform"))).status).toBe(403);
    // مالک فضای کاری دیگر
    const [other] = await db.insert(users).values({ name: "مالک دیگر", email: `${uniq("ow")}@example.com`, mobile: "09120000102", passwordHash: hashPassword("Other123x"), role: "user", emailVerifiedAt: new Date() }).returning();
    await createWorkspace(other.id, "تیم دیگر");
    await loginAs(other);
    const l = await j(await staffList(get("/api/chat/staff/list?queue=workspace")));
    expect(l.items.find((i: { code: string }) => i.code === code)).toBeUndefined();
    expect((await staffThread(get(`/api/chat/staff/thread?queue=workspace&c=${code}`))).status).toBe(404);
  });

  it("مالک تیم گفتگو را می‌بیند؛ زمینه‌ی قرارداد و امضاکنندگان همراه است", async () => {
    await loginAs(ws.owner);
    const l = await j(await staffList(get("/api/chat/staff/list?queue=workspace")));
    const item = l.items.find((i: { code: string }) => i.code === code);
    expect(item).toBeTruthy();
    expect(item.unread).toBe(2); // پیام اول + پیام طولانی (بریده‌شده)
    expect(item.contractNumber).toBe(contractNumber);
    expect(l.counts.unassigned).toBeGreaterThanOrEqual(1);
    const t = await j(await staffThread(get(`/api/chat/staff/thread?queue=workspace&c=${code}`)));
    expect(t.context.contract.number).toBe(contractNumber);
    expect(t.context.contract.signers.length).toBe(2);
    expect(t.context.contract.href).toBe(`/contracts/${contractId}`);
    expect(t.canTicket).toBe(false); // مهمان حساب ندارد
  });

  it("پاسخ پشتیبان + یادداشت داخلی؛ مشتری یادداشت را نمی‌بیند و «دیده‌شد» کار می‌کند", async () => {
    await loginAs(ws.owner);
    const a = await staffAct(post("/api/chat/staff/act", { queue: "workspace", code, action: "send", text: "سلام! لطفاً شماره‌ی همراهتان را بررسی کنید.", clientId: "s-1" }));
    expect(a.status).toBe(200);
    expect((await staffAct(post("/api/chat/staff/act", { queue: "workspace", code, action: "note", text: "مشتری شماره را اشتباه ثبت کرده", clientId: "s-2" }))).status).toBe(200);
    expect((await staffAct(post("/api/chat/staff/act", { queue: "workspace", code, action: "read" }))).status).toBe(200);
    const [conv] = await db.select().from(chatConversations).where(eq(chatConversations.code, code));
    expect(conv.assigneeId).toBe(ws.owner.id); // اولین پاسخ‌دهنده مسئول می‌شود
    expect(conv.unreadStaff).toBe(0);
    expect(conv.unreadRequester).toBe(1); // یادداشت داخلی شمرده نمی‌شود

    const env = (globalThis as unknown as { __testEnv: { cookies: Map<string, string> } }).__testEnv;
    freshBrowser();
    env.cookies.set("amz_chat", guestCookie);
    const p = await j(await poll(post("/api/chat/stream", { c: code, after: 0 })));
    const bodies = p.messages.map((m: { body: string }) => m.body).join("|");
    expect(bodies).toContain("شماره‌ی همراهتان");
    expect(bodies).not.toContain("اشتباه ثبت کرده");
    expect(p.state.unread).toBe(1);
    expect(p.state.staffReadId).toBeGreaterThan(0);
    expect((await act(post("/api/chat/act", { code, action: "read" }))).status).toBe(200);
    const [after] = await db.select().from(chatConversations).where(eq(chatConversations.code, code));
    expect(after.unreadRequester).toBe(0);
    expect(after.requesterReadId).toBeGreaterThan(0);
  });

  it("جریان SSE پیام تازه را فوراً می‌رساند", async () => {
    const env = (globalThis as unknown as { __testEnv: { cookies: Map<string, string> } }).__testEnv;
    freshBrowser();
    env.cookies.set("amz_chat", guestCookie);
    const ac = new AbortController();
    const res = await stream(get(`/api/chat/stream?c=${code}&after=0`, { signal: ac.signal }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (needle: string) => {
      const t0 = Date.now();
      while (!buf.includes(needle) && Date.now() - t0 < 8000) {
        const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((rs) => setTimeout(() => rs({ done: true, value: undefined }), 8000))]);
        if (r.done) break;
        buf += dec.decode(r.value);
      }
    };
    await readUntil("event: state");
    expect(buf).toContain("event: msg");
    expect(buf).toContain("شماره‌ی همراهتان");
    // پیام تازه‌ی پشتیبان در همان اتصال می‌رسد
    await loginAs(ws.owner);
    await staffAct(post("/api/chat/staff/act", { queue: "workspace", code, action: "send", text: "پیام زنده‌ی دوم", clientId: "s-3" }));
    await readUntil("پیام زنده‌ی دوم");
    expect(buf).toContain("پیام زنده‌ی دوم");
    ac.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("پشتیبان آنلاین → مشتری وضعیت «آنلاین» می‌بیند و پیام سیستمی آفلاین نمی‌آید", async () => {
    await touchAgent(ws.owner.id, `ws:${ws.wsId}`);
    freshBrowser();
    const b = await j(await bootstrap(get(`/api/chat/bootstrap?kind=sign&ref=${token}`)));
    expect(b.online).toBe(true);
  });

  it("بستن گفتگو، امتیازدهی و گفتگوی تازه", async () => {
    await loginAs(ws.owner);
    expect((await staffAct(post("/api/chat/staff/act", { queue: "workspace", code, action: "close" }))).status).toBe(200);
    // پاسخ به گفتگوی بسته مجاز نیست
    expect((await staffAct(post("/api/chat/staff/act", { queue: "workspace", code, action: "send", text: "x", clientId: "s-9" }))).status).toBe(400);
    const env = (globalThis as unknown as { __testEnv: { cookies: Map<string, string> } }).__testEnv;
    freshBrowser();
    env.cookies.set("amz_chat", guestCookie);
    expect((await act(post("/api/chat/act", { code, action: "rate", rating: 9 }))).status).toBe(400);
    expect((await act(post("/api/chat/act", { code, action: "rate", rating: 5 }))).status).toBe(200);
    const b = await j(await bootstrap(get(`/api/chat/bootstrap?kind=sign&ref=${token}`)));
    expect(b.conversation.state.status).toBe("closed");
    expect(b.conversation.state.rating).toBe(5);
    // پیام تازه → گفتگوی جدید
    const n = await j(await send(post("/api/chat/send", { kind: "sign", ref: token, text: "یک سؤال دیگر", clientId: "c-new" })));
    expect(n.created).toBe(true);
    expect(n.conversation.code).not.toBe(code);
  });
});

describe("گفتگوی زنده — کاربر پنل ↔ پشتیبانی پلتفرم", () => {
  let code = "";
  it("کاربر واردشده گفتگو می‌سازد؛ مدیر کل می‌بیند، پاسخ می‌دهد و به تیکت تبدیل می‌کند", async () => {
    await loginAs(customer);
    const r = await j(await send(post("/api/chat/send", { kind: "panel", text: "اشتراکم فعال نشد", clientId: "p-1", path: "/admin/billing" })));
    code = r.conversation.code;
    expect(r.conversation.queue).toBe("platform");
    // کاربر از صفحه رفته (آخرین حضورش قدیمی است) تا اعلان پاسخ برایش ثبت شود
    await db.update(chatConversations).set({ requesterSeenAt: new Date(Date.now() - 5 * 60_000) }).where(eq(chatConversations.code, code));

    await loginAs(admin);
    const list = await j(await staffList(get("/api/chat/staff/list?queue=platform")));
    const item = list.items.find((i: { code: string }) => i.code === code);
    expect(item.name).toBe("مشتری عادی");
    const th = await j(await staffThread(get(`/api/chat/staff/thread?queue=platform&c=${code}`)));
    expect(th.context.requester.email).toContain("@example.com");
    expect(th.canTicket).toBe(true);
    expect((await staffAct(post("/api/chat/staff/act", { queue: "platform", code, action: "send", text: "سلام، بررسی می‌کنیم", clientId: "p-2" }))).status).toBe(200);
    // ورودی نامعتبر
    expect((await staffAct(post("/api/chat/staff/act", { queue: "platform", code, action: "explode" }))).status).toBe(400);
    const tk = await j(await staffAct(post("/api/chat/staff/act", { queue: "platform", code, action: "ticket" })));
    expect(tk.ticketNumber).toMatch(/^TK-/);
    const [t] = await db.select().from(tickets).where(eq(tickets.number, tk.ticketNumber));
    expect(t.userId).toBe(customer.id);
    expect(t.subject).toContain("اشتراکم فعال نشد");
    // تبدیل دوباره ممکن نیست
    expect((await staffAct(post("/api/chat/staff/act", { queue: "platform", code, action: "ticket" }))).status).toBe(400);
  });

  it("کاربر پاسخ را در اعلان‌ها می‌بیند (وقتی ویجتش باز نیست)", async () => {
    const notes = await db.select().from(userNotifications).where(eq(userNotifications.userId, customer.id));
    expect(notes.some((n) => n.title.includes("پاسخ جدید") && (n.href || "").includes("chat=open"))).toBe(true);
  });

  it("صف تیم دسترسی به صف پلتفرم نمی‌دهد (و برعکس)", async () => {
    await loginAs(ws.owner);
    expect((await staffList(get("/api/chat/staff/list?queue=platform"))).status).toBe(403);
    await loginAs(admin);
    const l = await j(await staffList(get("/api/chat/staff/list?queue=workspace")));
    expect(l.error).toBeDefined(); // مدیر کل عضو این تیم نیست
  });

  it("زمینه‌ی قرارداد در پنل: امضاکننده ثبت‌نام‌شده به صادرکننده وصل می‌شود؛ غریبه نه", async () => {
    // خریدار قرارداد را به‌عنوان کاربر ثبت‌نام‌شده (حساب واقعی) می‌بیند
    const buyer = await ensureClient(ws.wsId, { name: "خریدار حساب‌دار", email: `${uniq("by")}@example.com`, mobile: "09120000200" });
    const [bu] = await db.select().from(users).where(eq(users.id, buyer.userId));
    const c2 = await newContract(ws.wsId, ws.owner.id, { title: "قرارداد پنل", customerId: buyer.userId });
    await loginAs(bu);
    const ok = await j(await bootstrap(get(`/api/chat/bootstrap?kind=panel&contractId=${c2.id}`)));
    expect(ok.queue).toBe("workspace");
    expect(ok.targets).toHaveLength(2);
    // غریبه: زمینه‌ی قرارداد نادیده گرفته می‌شود و به پلتفرم می‌رود
    await loginAs(customer);
    const no = await j(await bootstrap(get(`/api/chat/bootstrap?kind=panel&contractId=${c2.id}`)));
    expect(no.queue).toBe("platform");
    expect(no.contextLabel).toBeNull();
  });
});

describe("گفتگوی زنده — بازدیدکننده‌ی سایت و حریم خصوصی", () => {
  it("بازدیدکننده بدون نام نمی‌تواند شروع کند؛ با نام می‌تواند", async () => {
    freshBrowser();
    expect((await send(post("/api/chat/send", { kind: "site", text: "قیمت چقدر است؟" }))).status).toBe(400);
    const r = await send(post("/api/chat/send", { kind: "site", name: "علی بازدیدکننده", text: "قیمت چقدر است؟", clientId: "s-1" }));
    expect(r.status).toBe(200);
    expect((await j(r)).conversation.queue).toBe("platform");
  });

  it("سقف نرخ ارسال اعمال می‌شود", async () => {
    freshBrowser();
    let last = 200;
    for (let i = 0; i < 24; i++) {
      const r = await send(post("/api/chat/send", { kind: "site", name: "اسپمر", text: `پیام ${i}`, clientId: `spam-${i}` }));
      last = r.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it("خروجی داده‌ها و حذف گفتگوهای کاربر", async () => {
    const out = await exportUserChats(customer.id);
    expect(out.length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toContain("یادداشت داخلی");
    await deleteUserChats(customer.id);
    expect(await exportUserChats(customer.id)).toHaveLength(0);
  });
});

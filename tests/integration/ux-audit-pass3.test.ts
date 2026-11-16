import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import { unzipSync } from "fflate";
import { db } from "@/db";
import { contracts, mobileVerifications, users, workspaceInvites, workspaceMembers } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { foldSearch, matchesSearch, searchVariants } from "@/lib/search-text";
import { filterUserRows, issueContract, listContractsForUser, queryContracts, getSigners } from "@/modules/contracts/service";
import { parsePage, parseUserFilter } from "@/modules/contracts/user-filter";
import { createWorkspace } from "@/modules/tenancy/service";
import { ensureGuestSigner } from "@/modules/guests/service";
import { createSession } from "@/modules/auth/session";
import { getOrCreateSigningLink } from "@/modules/signing/links";
import { guestSendOtpAction, guestSignAction, guestVerifyOtpAction } from "@/modules/signing/guest-actions";
import { changeRoleStateAction, inviteMemberAction, removeMemberStateAction, resendInviteAction, revokeInviteStateAction } from "@/modules/tenancy/actions";
import { GET as vaultPdfRoute } from "@/app/api/vault/contracts/[id]/pdf/route";
import { GET as vaultExportRoute } from "@/app/api/vault/export/route";
import { vaultPrefAction, vaultSendCodeAction, vaultVerifyCodeAction } from "@/modules/vault/actions";
import { VAULT_ERRORS, VAULT_ZIP_PART_SIZE, vaultZipParts } from "@/modules/vault/limits";
import { listVaultDocs, vaultZip } from "@/modules/vault/service";
import { freshBrowser, form, makePng, resetRateLimit, run, setIp, uniq } from "../helpers";

/* ───────── ۱) یکسان‌سازی جستجو ───────── */
describe("جستجوی فارسی‌دوست (ارقام و حروف یکسان‌سازی می‌شوند)", () => {
  it("foldSearch: ارقام فارسی/عربی، ي/ك عربی، نیم‌فاصله و اعراب", () => {
    expect(foldSearch("قرارداد ۱۴۰۴ – ٢٣")).toBe("قرارداد 1404 – 23");
    expect(foldSearch("پيمانكاري")).toBe(foldSearch("پیمانکاری"));
    expect(foldSearch("می‌خواهم")).toBe("می خواهم");
    expect(foldSearch("كِتاب")).toBe("کتاب");
  });

  it("matchesSearch: همه‌ی واژه‌ها باید باشند، ترتیب مهم نیست، خالی ⇒ همه", () => {
    const hay = "قرارداد اجاره EMZ-1404-0007 فرستنده: شرکت الف";
    expect(matchesSearch(hay, "۱۴۰۴ اجاره")).toBe(true);
    expect(matchesSearch(hay, "emz-1404")).toBe(true);
    expect(matchesSearch(hay, "اجاره بیمه")).toBe(false);
    expect(matchesSearch(hay, "   ")).toBe(true);
  });

  it("searchVariants: گونه‌های لاتین/فارسی و ی‌ک فارسی/عربی برای ILIKE (حداکثر ۵)", () => {
    const v = searchVariants("پيمانكاري 12");
    expect(v).toContain("پیمانکاری 12");
    expect(v).toContain("پیمانکاری ۱۲");
    expect(v).toContain("پيمانكاري 12");
    expect(v.length).toBeLessThanOrEqual(5);
    expect(searchVariants("")).toEqual([]);
  });

  it("parseUserFilter / parsePage: ورودی ناشناس امن است", () => {
    expect(parseUserFilter("my_turn")).toBe("my_turn");
    expect(parseUserFilter("closed")).toBe("closed");
    expect(parseUserFilter("<script>")).toBe("all");
    expect(parsePage("3")).toBe(3);
    expect(parsePage("-1")).toBe(1);
    expect(parsePage("abc")).toBe(1);
  });
});

/* ───────── ۲) جستجو و بازه‌ی تاریخ در فهرست مدیر / داشبورد کاربر ───────── */
describe("فهرست قراردادها: جستجو، بازه‌ی تاریخ تهران، فیلتر داشبورد کاربر", () => {
  let ws = 0;
  let ownerId = 0;
  let customerUserId = 0;
  const ids: Record<string, number> = {};
  const body = "<p>این قرارداد برای آزمون ممیزی است و میان دو طرف منعقد می‌شود.</p>";

  beforeAll(async () => {
    const [owner] = await db.insert(users).values({ name: "مالک جستجو", email: `${uniq("s")}@example.com`, mobile: "09120000091", passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() }).returning();
    ownerId = owner.id;
    ws = await createWorkspace(owner.id, "فضای جستجو");
    const g = await ensureGuestSigner(ws, { name: "علی رضایی", mobile: "09125550041" });
    customerUserId = g.userId;
    ids.a = await issueContract({ workspaceId: ws, title: "قرارداد پیمانکاری ساختمان", bodyHtml: body, customerId: g.userId, createdBy: owner.id });
    ids.b = await issueContract({ workspaceId: ws, title: "تفاهم‌نامه همکاری", bodyHtml: body, customerId: g.userId, createdBy: owner.id });
    // ۰۰:۳۰ بامداد ۲ ژوئن ۲۰۲۵ به وقت تهران = ۲۱:۰۰ UTC روز ۱ ژوئن (مرز روز؛ باید به «روز تهران» تعلق بگیرد نه روز UTC)
    await db.update(contracts).set({ issuedAt: new Date("2025-06-01T21:00:00Z") }).where(eq(contracts.id, ids.b));
    await db.update(contracts).set({ issuedAt: new Date("2025-05-10T08:00:00Z") }).where(eq(contracts.id, ids.a));
  });

  const find = async (f: Parameters<typeof queryContracts>[1]) => (await queryContracts(ws, f)).rows.map((r) => r.id).sort();

  it("عنوان با «ي/ك» عربی و نام مشتری با «ي» عربی پیدا می‌شود", async () => {
    expect(await find({ q: "پيمانكاري" })).toEqual([ids.a]);
    expect(await find({ q: "علي رضايي" })).toEqual([ids.a, ids.b].sort());
  });

  it("شماره‌ی قرارداد با ارقام فارسی پیدا می‌شود", async () => {
    const [row] = await db.select({ number: contracts.number }).from(contracts).where(eq(contracts.id, ids.a));
    const digits = row.number.match(/\d{3,}/)?.[0];
    expect(digits).toBeTruthy();
    const persian = digits!.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
    expect(await find({ q: persian })).toContain(ids.a);
  });

  it("بازه‌ی تاریخ به وقت تهران است (نه UTC سرور)", async () => {
    expect(await find({ from: "2025-06-02", to: "2025-06-02" })).toEqual([ids.b]);
    expect(await find({ from: "2025-06-01", to: "2025-06-01" })).toEqual([]);
    expect(await find({ from: "2025-05-01", to: "2025-06-02" })).toEqual([ids.a, ids.b].sort());
  });

  it("«از» بزرگ‌تر از «تا» جابه‌جا می‌شود (نه نتیجه‌ی خالی بی‌دلیل)؛ تاریخ خراب نادیده گرفته می‌شود", async () => {
    expect(await find({ from: "2025-06-02", to: "2025-05-01" })).toEqual([ids.a, ids.b].sort());
    expect(await find({ from: "2025-13-45", to: "garbage" })).toEqual([ids.a, ids.b].sort());
  });

  it("فیلترهای «نوبت شما» و «رد/لغو/منقضی» در داشبورد کاربر", async () => {
    const mine = await listContractsForUser(customerUserId, "all");
    expect(mine.length).toBe(2);
    expect((await listContractsForUser(customerUserId, "my_turn")).length).toBe(2);
    expect((await listContractsForUser(customerUserId, "closed")).length).toBe(0);
    await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, ids.b));
    expect((await listContractsForUser(customerUserId, "closed")).map((r) => r.id)).toEqual([ids.b]);
    expect((await listContractsForUser(customerUserId, "my_turn")).map((r) => r.id)).toEqual([ids.a]);
    expect(filterUserRows([{ state: "waiting" }, { state: "my_turn" }, { state: "expired" }], "pending").length).toBe(2);
    expect(ownerId).toBeGreaterThan(0);
  });
});

/* ───────── ۳) کیف اسناد ───────── */
describe("کیف اسناد: دانلود بدون بن‌بست، بایگانی امن، ZIP کامل", () => {
  const MOBILE = "09125550051";
  const ids: { a: number; b: number; pending: number } = { a: 0, b: 0, pending: 0 };

  async function sign(contractId: number) {
    const [s] = await getSigners(contractId);
    const link = (await getOrCreateSigningLink(s.id))!;
    const sent = await guestSendOtpAction(link.token);
    expect((await guestVerifyOtpAction(link.token, sent.devCode!)).ok).toBe(true);
    expect((await guestSignAction(link.token, { signature: makePng(), method: "draw", agree: true })).ok).toBe(true);
  }
  const login = async () => {
    await db.delete(mobileVerifications);
    const sent = await vaultSendCodeAction(MOBILE);
    expect((await vaultVerifyCodeAction(MOBILE, sent.devCode!)).ok).toBe(true);
  };
  const nav = { headers: { "sec-fetch-mode": "navigate", accept: "text/html,application/xhtml+xml" } };
  const pdf = (id: number, init?: RequestInit) => vaultPdfRoute(new Request(`http://localhost/api/vault/contracts/${id}/pdf`, init), { params: Promise.resolve({ id: String(id) }) });

  beforeAll(async () => {
    const mk = async (n: string, mobile: string) => (await db.insert(users).values({ name: n, email: `${uniq("v")}@example.com`, mobile, passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() }).returning())[0];
    const o1 = await mk("فروشنده ۱", "09120000092");
    const o2 = await mk("فروشنده ۲", "09120000093");
    const w1 = await createWorkspace(o1.id, "کسب‌وکار یک");
    const w2 = await createWorkspace(o2.id, "کسب‌وکار دو");
    const body = "<h2>قرارداد</h2><p>متن آزمون کیف اسناد میان [USER_NAME] و فروشنده منعقد شد و الزام‌آور است.</p>";
    const g1 = await ensureGuestSigner(w1, { name: "نرگس کیفی", mobile: MOBILE });
    const g2 = await ensureGuestSigner(w2, { name: "نرگس کیفی", mobile: MOBILE });
    ids.a = await issueContract({ workspaceId: w1, title: "قرارداد یک", bodyHtml: body, customerId: g1.userId, createdBy: o1.id });
    ids.b = await issueContract({ workspaceId: w2, title: "قرارداد دو", bodyHtml: body, customerId: g2.userId, createdBy: o2.id });
    ids.pending = await issueContract({ workspaceId: w2, title: "قرارداد منتظر", bodyHtml: body, customerId: g2.userId, createdBy: o2.id });
    await sign(ids.a);
    await sign(ids.b);
  });
  beforeEach(() => {
    freshBrowser();
    setIp("10.9.3.1");
    resetRateLimit("vaultcode:ip:10.9.3.1");
  });

  it("دانلود با کلیک (مرورگر) هرگز JSON خام نشان نمی‌دهد؛ به کیف با پیام روشن برمی‌گردد — و API همان JSON قبلی را می‌دهد", async () => {
    // نشست تمام‌شده
    const noSession = await pdf(ids.a, nav);
    expect(noSession.status).toBe(303);
    expect(noSession.headers.get("location")).toContain("/vault?e=auth");
    expect((await pdf(ids.a)).status).toBe(401); // کلاینت برنامه‌ای
    const zipNav = await vaultExportRoute(new Request("http://localhost/api/vault/export", nav));
    expect(zipNav.headers.get("location")).toContain("/vault?e=auth");

    await login();
    const notFinal = await pdf(ids.pending, nav);
    expect(notFinal.status).toBe(303);
    expect(notFinal.headers.get("location")).toContain("/vault?e=nodoc");
    expect((await pdf(ids.pending)).status).toBe(404);
    expect((await pdf(ids.a, nav)).status).toBe(200); // موفق: خود فایل
    for (const code of ["auth", "nodoc", "pdf", "tampered", "rate", "zip", "closed"]) expect(VAULT_ERRORS[code]).toBeTruthy();
  });

  it("سندِ منتظر امضای خود کاربر بایگانی نمی‌شود؛ سند نهایی می‌شود", async () => {
    await login();
    const blocked = await vaultPrefAction(ids.pending, { archived: true });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("منتظر امضای شماست");
    expect((await listVaultDocs(MOBILE)).find((d) => d.id === ids.pending)!.archived).toBe(false);
    expect((await vaultPrefAction(ids.a, { archived: true })).ok).toBe(true);
    expect((await vaultPrefAction(ids.a, { archived: false })).ok).toBe(true);
    // سنجاق و یادداشت روی سند منتظر امضا همچنان آزاد است
    expect((await vaultPrefAction(ids.pending, { pinned: true, note: "فردا امضا شود" })).ok).toBe(true);
  });

  it("ZIP: بخش‌بندی روشن، شماره‌ی بخش خارج از بازه محدود می‌شود، و هیچ سندی روی دیگری بازنویسی نمی‌شود", async () => {
    expect(vaultZipParts(0)).toBe(1);
    expect(vaultZipParts(VAULT_ZIP_PART_SIZE)).toBe(1);
    expect(vaultZipParts(VAULT_ZIP_PART_SIZE + 1)).toBe(2);

    const z = await vaultZip(MOBILE, 99);
    expect(z).toMatchObject({ part: 1, parts: 1, total: 2, count: 2, skipped: 0 });
    const files = unzipSync(new Uint8Array(z.buffer));
    const pdfs = Object.keys(files).filter((n) => n.endsWith(".pdf"));
    expect(pdfs.length).toBe(2); // حتی اگر شماره‌ی دو فرستنده یکسان باشد
    const index = Buffer.from(files["index.txt"]).toString("utf8");
    expect(index).toMatch(/مجموع 2 سند نهایی‌شده/);
    for (const n of pdfs) expect(index).toContain(n);

    await login();
    const res = await vaultExportRoute(new Request("http://localhost/api/vault/export?part=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-vault-part")).toBe("1/1");
    expect(res.headers.get("x-vault-skipped")).toBe("0");
  });
});

/* ───────── ۴) مدیریت تیم: بازخورد روشن و دعوت‌های بی‌بن‌بست ───────── */
describe("مدیریت تیم", () => {
  let owner: { id: number; passwordHash: string };
  let ws = 0;
  let mseq = 0;
  const mkUser = async (name: string) => (await db.insert(users).values({ name, email: `${uniq("t")}@example.com`, mobile: `0912000${String(9500 + mseq++).padStart(4, "0")}`, passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() }).returning())[0];
  const addMember = async (userId: number, role: string) => (await db.insert(workspaceMembers).values({ workspaceId: ws, userId, role }).returning())[0];

  beforeAll(async () => {
    owner = (await db.insert(users).values({ name: "مالک تیم", email: `${uniq("o")}@example.com`, mobile: "09120000094", passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() }).returning())[0];
    ws = await createWorkspace(owner.id, "تیم آزمون");
  });
  beforeEach(async () => {
    freshBrowser();
    await createSession(owner.id, owner.passwordHash);
  });
  // طرح پیش‌فرض ۲ صندلی دارد؛ هر آزمون با تیمِ فقط-مالک و بدون دعوت باز شروع می‌شود
  afterEach(async () => {
    await db.delete(workspaceInvites).where(eq(workspaceInvites.workspaceId, ws));
    await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ws), ne(workspaceMembers.role, "owner")));
  });

  it("تغییر نقش: پیام موفقیت، رد با دلیل (مالک/خود/عضو ناموجود) — نه سکوت", async () => {
    const u = await mkUser("همکار اول");
    const m = await addMember(u.id, "member");
    const ok = await run(() => changeRoleStateAction({}, form({ memberId: String(m.id), role: "viewer" })));
    expect(ok.result).toMatchObject({ ok: true });
    expect((ok.result as { message: string }).message).toContain("ناظر");
    expect((await db.select().from(workspaceMembers).where(eq(workspaceMembers.id, m.id)))[0].role).toBe("viewer");

    const same = await run(() => changeRoleStateAction({}, form({ memberId: String(m.id), role: "viewer" })));
    expect(same.result).toMatchObject({ ok: true });

    const [ownerRow] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ws), eq(workspaceMembers.userId, owner.id)));
    const denied = await run(() => changeRoleStateAction({}, form({ memberId: String(ownerRow.id), role: "member" })));
    expect((denied.result as { error?: string }).error).toContain("اجازه");
    expect((await db.select().from(workspaceMembers).where(eq(workspaceMembers.id, ownerRow.id)))[0].role).toBe("owner");

    const ghost = await run(() => changeRoleStateAction({}, form({ memberId: "99999999", role: "member" })));
    expect((ghost.result as { error?: string }).error).toBeTruthy();
    const bad = await run(() => changeRoleStateAction({}, form({ memberId: String(m.id), role: "owner" })));
    expect((bad.result as { error?: string }).error).toContain("مالک");
    expect((await db.select().from(workspaceMembers).where(eq(workspaceMembers.id, m.id)))[0].role).toBe("viewer");
  });

  it("حذف عضو: پیام موفقیت؛ حذف دوباره یا مالک با دلیل رد می‌شود", async () => {
    const u = await mkUser("همکار دوم");
    const m = await addMember(u.id, "member");
    const ok = await run(() => removeMemberStateAction({}, form({ memberId: String(m.id) })));
    expect(ok.result).toMatchObject({ ok: true });
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.id, m.id))).toHaveLength(0);
    const again = await run(() => removeMemberStateAction({}, form({ memberId: String(m.id) })));
    expect((again.result as { error?: string }).error).toContain("دیگر در تیم نیست");
    const [ownerRow] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ws), eq(workspaceMembers.userId, owner.id)));
    const self = await run(() => removeMemberStateAction({}, form({ memberId: String(ownerRow.id) })));
    expect((self.result as { error?: string }).error).toContain("اجازه");
  });

  it("دعوت دوباره برای همان ایمیل، دعوت باز قبلی را جایگزین می‌کند (بدون ردیف تکراری) ولی دعوت «مشتری» را لغو نمی‌کند", async () => {
    const email = `${uniq("inv")}@example.com`;
    const clientToken = (await import("@/modules/tenancy/invites")).createInvite;
    await clientToken(ws, email, "client", owner.id);
    const first = await run(() => inviteMemberAction({}, form({ email, role: "member" })));
    expect(first.result).toMatchObject({ ok: true });
    const second = await run(() => inviteMemberAction({}, form({ email, role: "viewer" })));
    expect(second.result).toMatchObject({ ok: true });
    const rows = await db.select().from(workspaceInvites).where(and(eq(workspaceInvites.workspaceId, ws), eq(workspaceInvites.email, email)));
    expect(rows.filter((r) => r.role !== "client")).toHaveLength(1);
    expect(rows.filter((r) => r.role !== "client")[0].role).toBe("viewer");
    expect(rows.filter((r) => r.role === "client")).toHaveLength(1);
  });

  it("ارسال دوباره‌ی دعوت منقضی‌شده: دعوت تازه + لینک قابل‌کپی؛ لغو دعوت ناموجود پیام روشن می‌دهد", async () => {
    const email = `${uniq("exp")}@example.com`;
    await run(() => inviteMemberAction({}, form({ email, role: "member" })));
    const [old] = await db.select().from(workspaceInvites).where(and(eq(workspaceInvites.workspaceId, ws), eq(workspaceInvites.email, email)));
    await db.update(workspaceInvites).set({ expiresAt: new Date(Date.now() - 86400_000) }).where(eq(workspaceInvites.id, old.id));

    const r = await run(() => resendInviteAction({}, form({ id: String(old.id) })));
    const res = r.result as { ok?: boolean; link?: string; error?: string };
    expect(res.ok).toBe(true);
    expect(res.link).toMatch(/\/invite\/[a-f0-9]{64}$/);
    const rows = await db.select().from(workspaceInvites).where(and(eq(workspaceInvites.workspaceId, ws), eq(workspaceInvites.email, email)));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(old.id);
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());

    const gone = await run(() => resendInviteAction({}, form({ id: String(old.id) })));
    expect((gone.result as { error?: string }).error).toContain("دیگر وجود ندارد");
    const revoke = await run(() => revokeInviteStateAction({}, form({ id: String(rows[0].id) })));
    expect(revoke.result).toMatchObject({ ok: true });
    const revokeAgain = await run(() => revokeInviteStateAction({}, form({ id: String(rows[0].id) })));
    expect((revokeAgain.result as { error?: string }).error).toContain("دیگر وجود ندارد");
  });
});

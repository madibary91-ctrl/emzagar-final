import crypto from "node:crypto";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { referralCodes, referrals, users, workspaceMembers, workspaces } from "@/db/schema";
import { escapeHtml } from "@/lib/html";
import { grantFreeDays } from "@/modules/billing/subscription";
import { logAudit } from "@/modules/audit/service";
import { notifyUser } from "@/modules/inbox/service";
import { sendMail } from "@/modules/mail";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";
import { applyWalletOps, type WalletOp } from "@/modules/wallet/service";
import { DEFAULT_REFERRAL, REFERRAL_ALPHABET, REFERRAL_CODE_RE, normalizeReferralCode, sanitizeReferralConfig, type ReferralConfig } from "./config";

/* ───────── تنظیمات ───────── */
export async function getReferralConfig(): Promise<ReferralConfig> {
  try {
    const raw = (await getGlobalSetting("referral_cfg")).trim();
    return raw ? sanitizeReferralConfig(JSON.parse(raw) as Record<string, unknown>) : DEFAULT_REFERRAL;
  } catch {
    return DEFAULT_REFERRAL;
  }
}
export async function saveReferralConfig(cfg: ReferralConfig) {
  await saveGlobalSetting("referral_cfg", JSON.stringify(sanitizeReferralConfig({ ...cfg })));
}

/* ───────── کد دعوت ───────── */
function randomCode(): string {
  const bytes = crypto.randomBytes(6);
  return "EMZ" + Array.from(bytes, (b) => REFERRAL_ALPHABET[b % REFERRAL_ALPHABET.length]).join("");
}

/** کد اختصاصی کاربر؛ اگر هنوز نساخته شده باشد ساخته می‌شود */
export async function getOrCreateCode(userId: number): Promise<string> {
  const [row] = await db.select().from(referralCodes).where(eq(referralCodes.userId, userId));
  if (row) return row.code;
  for (let i = 0; i < 8; i++) {
    const code = randomCode();
    const ins = await db.insert(referralCodes).values({ userId, code }).onConflictDoNothing().returning();
    if (ins[0]) return ins[0].code;
    // یا کد تکراری بود یا هم‌زمان کد ساخته شد
    const [again] = await db.select().from(referralCodes).where(eq(referralCodes.userId, userId));
    if (again) return again.code;
  }
  throw new Error("ساخت کد دعوت ممکن نشد");
}

export async function resolveCode(raw: unknown): Promise<number | null> {
  const code = normalizeReferralCode(raw);
  if (!REFERRAL_CODE_RE.test(code)) return null;
  const [row] = await db.select({ userId: referralCodes.userId }).from(referralCodes).where(eq(referralCodes.code, code));
  return row?.userId ?? null;
}

/* ───────── ثبت دعوت هنگام ثبت‌نام ───────── */
const MAX_PER_IP_PER_REFERRER = 2;

/** پس از ثبت‌نام: اگر کد معتبر بود دعوت ثبت می‌شود. هرگز خطا پرتاب نمی‌کند و ثبت‌نام را مختل نمی‌کند. */
export async function attachReferral(p: { code: unknown; referred: { id: number; mobile: string }; workspaceId: number; ip: string }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const cfg = await getReferralConfig();
    if (!cfg.enabled) return { ok: false, reason: "disabled" };
    const referrerId = await resolveCode(p.code);
    if (!referrerId) return { ok: false, reason: "invalid_code" };
    if (referrerId === p.referred.id) return { ok: false, reason: "self" };
    const [referrer] = await db.select().from(users).where(eq(users.id, referrerId));
    if (!referrer) return { ok: false, reason: "invalid_code" };

    let status = "pending";
    let note = "";
    // خودمعرفی با شماره‌ی موبایل یکسان
    if (referrer.mobile && referrer.mobile === p.referred.mobile) {
      status = "rejected";
      note = "موبایل یکسان با دعوت‌کننده";
    } else if (p.ip) {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(referrals)
        .where(and(eq(referrals.referrerUserId, referrerId), eq(referrals.signupIp, p.ip), gte(referrals.createdAt, new Date(Date.now() - 30 * 86400_000))));
      if (n >= MAX_PER_IP_PER_REFERRER) {
        status = "rejected";
        note = "ثبت‌نام‌های متعدد از یک شبکه";
      }
    }
    const ins = await db
      .insert(referrals)
      .values({ referrerUserId: referrerId, referredUserId: p.referred.id, referredWorkspaceId: p.workspaceId, code: normalizeReferralCode(p.code), status, signupIp: p.ip.slice(0, 64), note })
      .onConflictDoNothing()
      .returning({ id: referrals.id });
    if (!ins[0]) return { ok: false, reason: "duplicate" };
    await logAudit({ action: "referral.signup", userId: referrerId, detail: `دعوت #${ins[0].id} — ${status}${note ? ` (${note})` : ""}` });
    if (status === "pending") await notifyUser(referrerId, { kind: "info", title: "دوست شما ثبت‌نام کرد", body: "به‌محض صدور اولین قرارداد توسط او، پاداش شما فعال می‌شود.", href: "/admin/referrals" });
    return { ok: status === "pending", reason: status === "pending" ? undefined : "rejected" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/* ───────── تحقق پاداش ───────── */
/** فضای کاری که پاداش دعوت‌کننده به آن واریز می‌شود: اولین فضایی که مالک آن است */
async function rewardWorkspaceOf(userId: number): Promise<number | null> {
  const [own] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.ownerId, userId)).orderBy(asc(workspaces.id)).limit(1);
  if (own) return own.id;
  const [m] = await db.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(and(eq(workspaceMembers.userId, userId), sql`${workspaceMembers.role} in ('owner','admin')`)).orderBy(asc(workspaceMembers.id)).limit(1);
  return m?.id ?? null;
}

/**
 * وقتی فضای کاریِ دعوت‌شده «اولین قرارداد واقعی» (غیر پیش‌نویس) را صادر کرد صدا زده می‌شود.
 * پاداش فقط یک‌بار (claim اتمی pending→qualified + کلید یکتای دفتر کل) و فقط با ایمیل تاییدشده پرداخت می‌شود.
 */
export async function qualifyReferralForWorkspace(workspaceId: number): Promise<void> {
  const [ref] = await db.select().from(referrals).where(and(eq(referrals.referredWorkspaceId, workspaceId), eq(referrals.status, "pending")));
  if (!ref) return;
  const [referred] = await db.select().from(users).where(eq(users.id, ref.referredUserId));
  if (!referred?.emailVerifiedAt) return; // بعد از تایید ایمیل و قرارداد بعدی دوباره بررسی می‌شود
  const cfg = await getReferralConfig();
  if (!cfg.enabled) return;

  const claimed = await db.update(referrals).set({ status: "qualified", qualifiedAt: new Date() }).where(and(eq(referrals.id, ref.id), eq(referrals.status, "pending"))).returning({ id: referrals.id });
  if (claimed.length === 0) return;

  const [{ n: doneBefore }] = await db.select({ n: sql<number>`count(*)::int` }).from(referrals).where(and(eq(referrals.referrerUserId, ref.referrerUserId), eq(referrals.status, "qualified")));
  const capped = doneBefore > cfg.maxRewarded;
  const referrerWs = await rewardWorkspaceOf(ref.referrerUserId);

  let referrerWallet = 0;
  let referrerCredits = 0;
  let bonusDays = 0;
  if (!capped && referrerWs) {
    const ops: WalletOp[] = [];
    if (cfg.referrerWallet > 0) ops.push({ asset: "toman", delta: cfg.referrerWallet, kind: "referral_reward", ref: `referral:${ref.id}:referrer:toman`, description: "پاداش دعوت دوست", userId: ref.referrerUserId });
    if (cfg.referrerCredits > 0) ops.push({ asset: "credits", delta: cfg.referrerCredits, kind: "referral_reward", ref: `referral:${ref.id}:referrer:credits`, description: "پاداش دعوت دوست", userId: ref.referrerUserId });
    if (ops.length && (await applyWalletOps(referrerWs, ops)).ok) {
      referrerWallet = cfg.referrerWallet;
      referrerCredits = cfg.referrerCredits;
    }
    if (cfg.milestoneEvery > 0 && cfg.milestoneDays > 0 && doneBefore % cfg.milestoneEvery === 0) {
      await grantFreeDays(referrerWs, cfg.milestoneDays);
      bonusDays = cfg.milestoneDays;
    }
  }

  let referredWallet = 0;
  let referredCredits = 0;
  const gift: WalletOp[] = [];
  if (cfg.referredWallet > 0) gift.push({ asset: "toman", delta: cfg.referredWallet, kind: "referral_reward", ref: `referral:${ref.id}:referred:toman`, description: "هدیه‌ی خوشامد (دعوت دوست)", userId: ref.referredUserId });
  if (cfg.referredCredits > 0) gift.push({ asset: "credits", delta: cfg.referredCredits, kind: "referral_reward", ref: `referral:${ref.id}:referred:credits`, description: "هدیه‌ی خوشامد (دعوت دوست)", userId: ref.referredUserId });
  if (gift.length && (await applyWalletOps(workspaceId, gift)).ok) {
    referredWallet = cfg.referredWallet;
    referredCredits = cfg.referredCredits;
  }

  await db.update(referrals).set({ referrerWallet, referrerCredits, referredWallet, referredCredits, bonusDays, note: capped ? "سقف پاداش دعوت‌کننده" : ref.note }).where(eq(referrals.id, ref.id));
  await logAudit({ action: "referral.rewarded", workspaceId, userId: ref.referrerUserId, detail: `دعوت #${ref.id} — دعوت‌کننده: ${referrerWallet} تومان + ${referrerCredits} اعتبار${bonusDays ? ` + ${bonusDays} روز اشتراک` : ""}` });
  if (!capped) {
    await notifyUser(ref.referrerUserId, { kind: "success", title: "پاداش دعوت دریافت شد 🎁", body: `${referrerWallet.toLocaleString("fa-IR")} تومان اعتبار${referrerCredits ? ` و ${referrerCredits.toLocaleString("fa-IR")} قرارداد` : ""}${bonusDays ? ` + ${bonusDays.toLocaleString("fa-IR")} روز اشتراک رایگان` : ""} به حساب شما افزوده شد.`, href: "/admin/referrals" });
  }
  if (referredWallet || referredCredits) await notifyUser(ref.referredUserId, { kind: "success", title: "هدیه‌ی خوشامد شما فعال شد 🎁", body: `${referredWallet.toLocaleString("fa-IR")} تومان${referredCredits ? ` و ${referredCredits.toLocaleString("fa-IR")} قرارداد` : ""} به کیف پول شما اضافه شد.`, href: "/admin/wallet" });
}

/* ───────── گزارش‌ها ───────── */
const maskName = (n: string) => {
  const t = n.trim();
  return t.length <= 2 ? `${t.slice(0, 1)}•` : `${t.slice(0, 2)}${"•".repeat(Math.min(5, t.length - 2))}`;
};

export async function referralOverview(userId: number) {
  const rows = await db
    .select({ r: referrals, name: users.name })
    .from(referrals)
    .innerJoin(users, eq(users.id, referrals.referredUserId))
    .where(eq(referrals.referrerUserId, userId))
    .orderBy(desc(referrals.id))
    .limit(100);
  const qualified = rows.filter((x) => x.r.status === "qualified");
  const cfg = await getReferralConfig();
  const every = cfg.milestoneEvery;
  return {
    list: rows.map((x) => ({ id: x.r.id, name: maskName(x.name), status: x.r.status, createdAt: x.r.createdAt, wallet: x.r.referrerWallet, credits: x.r.referrerCredits, days: x.r.bonusDays })),
    invited: rows.length,
    pending: rows.filter((x) => x.r.status === "pending").length,
    qualified: qualified.length,
    earnedWallet: qualified.reduce((a, x) => a + x.r.referrerWallet, 0),
    earnedCredits: qualified.reduce((a, x) => a + x.r.referrerCredits, 0),
    earnedDays: qualified.reduce((a, x) => a + x.r.bonusDays, 0),
    toNextMilestone: every > 0 ? every - (qualified.length % every) : 0,
  };
}

export async function platformReferralOverview() {
  const [t] = await db
    .select({
      total: sql<number>`count(*)::int`,
      qualified: sql<number>`count(*) filter (where ${referrals.status} = 'qualified')::int`,
      pending: sql<number>`count(*) filter (where ${referrals.status} = 'pending')::int`,
      rejected: sql<number>`count(*) filter (where ${referrals.status} = 'rejected')::int`,
      wallet: sql<number>`coalesce(sum(${referrals.referrerWallet} + ${referrals.referredWallet}),0)::bigint`,
      credits: sql<number>`coalesce(sum(${referrals.referrerCredits} + ${referrals.referredCredits}),0)::bigint`,
      days: sql<number>`coalesce(sum(${referrals.bonusDays}),0)::bigint`,
    })
    .from(referrals);
  const top = await db
    .select({ userId: referrals.referrerUserId, name: users.name, email: users.email, n: sql<number>`count(*) filter (where ${referrals.status} = 'qualified')::int`, all: sql<number>`count(*)::int` })
    .from(referrals)
    .innerJoin(users, eq(users.id, referrals.referrerUserId))
    .groupBy(referrals.referrerUserId, users.name, users.email)
    .orderBy(sql`count(*) filter (where ${referrals.status} = 'qualified') desc`, sql`count(*) desc`)
    .limit(8);
  return { total: t?.total ?? 0, qualified: t?.qualified ?? 0, pending: t?.pending ?? 0, rejected: t?.rejected ?? 0, wallet: Number(t?.wallet ?? 0), credits: Number(t?.credits ?? 0), days: Number(t?.days ?? 0), top };
}

/* ───────── دعوت با ایمیل ───────── */
export async function sendInviteEmails(p: { from: { id: number; name: string }; emails: string[]; origin: string }): Promise<{ sent: number }> {
  const code = await getOrCreateCode(p.from.id);
  const cfg = await getReferralConfig();
  const link = `${p.origin}/r/${code}`;
  let sent = 0;
  for (const to of p.emails) {
    const gift = cfg.referredWallet > 0 ? `<p>با ثبت‌نام از این لینک، <b>${cfg.referredWallet.toLocaleString("fa-IR")} تومان</b> هدیه‌ی خوشامد (پس از اولین قرارداد) دریافت می‌کنید.</p>` : "";
    await sendMail({
      to,
      subject: `${p.from.name} شما را به امضاگیر دعوت کرده است`,
      html: `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:2"><p>سلام 👋</p><p><b>${escapeHtml(p.from.name)}</b> شما را به «امضاگیر» (امضای آنلاین قرارداد) دعوت کرده است.</p>${gift}<p><a href="${escapeHtml(link)}" style="background:#102c31;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none">ساخت فضای کاری رایگان</a></p><p style="color:#667">${escapeHtml(link)}</p></div>`,
      workspaceId: 0,
    }).then(() => void sent++, () => undefined);
  }
  return { sent };
}

import { and, asc, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { contracts, contractSigners, users, vaultProfiles, workspaces } from "@/db/schema";
import { emailVerificationRequired } from "@/modules/auth/email-verify";
import { logAudit } from "@/modules/audit/service";
import { GuestUpgradeError, upgradeGuestToUser } from "@/modules/guests/service";
import { attachReferral, getOrCreateCode, getReferralConfig } from "@/modules/referral/service";
import { createWorkspace } from "@/modules/tenancy/service";

/**
 * ── حلقه‌ی ویروسی کیف اسناد ───────────────────────────────────────────────────
 *
 *  امضاکننده  ──امضا──▶  کیف اسناد (ارزش فوری)  ──۳۰ ثانیه──▶  حساب فروشنده  ──اولین قرارداد──▶  پاداش دوطرفه
 *       ▲                                                                                      │
 *       └────────────── او هم برای مشتریان خودش لینک امضا می‌فرستد (امضاکننده‌های جدید) ◀────────┘
 *
 *  • انتساب «اولین لمس»: فرستنده‌ای که اولین بار این شماره را به امضا کشاند، «دعوت‌کننده»ی رسمی می‌شود و با موتور
 *    موجود دعوت (referral) هم او هم امضاکننده پاداش می‌گیرند — بدون هیچ کد دعوتی که کسی بخواهد وارد کند.
 *  • ارتقای بدون اصطکاک: موبایل پیش‌تر با OTP تأیید شده؛ فقط ایمیل + رمز لازم است. همان ردیف مهمان به کاربر واقعی
 *    ارتقا می‌یابد (upgradeGuestToUser) و کل تاریخچه‌ی امضاها بی‌مهاجرت می‌ماند.
 */

export class VaultUpgradeError extends Error {}

export type FirstTouch = { referrerUserId: number; contractId: number; senderName: string };

/** فرستنده‌ی اولین قراردادِ «کسب‌وکاری» (نه ارسال سریع) که این موبایل با OTP امضا کرده است */
export async function firstTouchSender(mobile: string): Promise<FirstTouch | null> {
  const rows = await db
    .select({ contractId: contracts.id, createdBy: contracts.createdBy, ownerId: workspaces.ownerId, wsName: workspaces.name })
    .from(contractSigners)
    .innerJoin(users, eq(users.id, contractSigners.userId))
    .innerJoin(contracts, eq(contracts.id, contractSigners.contractId))
    .innerJoin(workspaces, eq(workspaces.id, contracts.workspaceId))
    .where(and(eq(users.mobile, mobile), eq(contractSigners.status, "signed"), eq(workspaces.kind, "team"), or(eq(users.isGuest, true), isNotNull(contractSigners.otpVerifiedAt))))
    .orderBy(asc(contractSigners.signedAt))
    .limit(8);
  for (const r of rows) {
    for (const candidate of [r.createdBy, r.ownerId]) {
      if (!candidate) continue;
      const [u] = await db.select({ id: users.id, isGuest: users.isGuest, mobile: users.mobile }).from(users).where(eq(users.id, candidate));
      if (u && !u.isGuest && u.mobile !== mobile) return { referrerUserId: u.id, contractId: r.contractId, senderName: r.wsName };
    }
  }
  return null;
}

export interface GrowthOffer {
  state: "can_upgrade" | "has_account" | "upgraded";
  /** نام فرستنده‌ای که امضاکننده را آورده (برای پیام شخصی‌سازی‌شده) */
  senderName: string;
  rewardsOn: boolean;
  giftWallet: number;
  giftCredits: number;
  milestoneDays: number;
}

export async function getGrowthOffer(mobile: string): Promise<GrowthOffer> {
  const [profile] = await db.select().from(vaultProfiles).where(eq(vaultProfiles.mobile, mobile));
  const cfg = await getReferralConfig();
  const touch = profile?.upgradedUserId ? null : await firstTouchSender(mobile);
  let state: GrowthOffer["state"] = "can_upgrade";
  if (profile?.upgradedUserId) state = "upgraded";
  else {
    const [real] = await db.select({ id: users.id }).from(users).where(and(eq(users.mobile, mobile), eq(users.isGuest, false), isNotNull(users.emailVerifiedAt))).limit(1);
    if (real) state = "has_account";
  }
  const on = cfg.enabled && !!touch && state === "can_upgrade";
  return { state, senderName: touch?.senderName ?? "", rewardsOn: on, giftWallet: on ? cfg.referredWallet : 0, giftCredits: on ? cfg.referredCredits : 0, milestoneDays: cfg.milestoneDays };
}

export interface UpgradeInput {
  mobile: string;
  email: string;
  passwordHash: string;
  name?: string;
  workspaceName: string;
  ip: string;
}

/**
 * ساخت حساب فروشنده از روی کیف: ارتقای ردیف مهمان (یا ساخت کاربر تازه اگر مهمانی نبود) + فضای کاری + انتساب دعوت.
 * پیش‌شرط (به‌عهده‌ی فراخواننده): مالکیت `mobile` همین الان در نشست کیف ثابت شده است.
 */
export async function upgradeVaultToAccount(input: UpgradeInput): Promise<{ user: typeof users.$inferSelect; workspaceId: number; rewarded: boolean }> {
  const { mobile } = input;
  const touch = await firstTouchSender(mobile);

  const out = await withTransaction(async () => {
    const [profile] = await db.select().from(vaultProfiles).where(eq(vaultProfiles.mobile, mobile)).for("update");
    if (profile?.upgradedUserId) throw new VaultUpgradeError("از همین کیف قبلاً حساب ساخته شده است؛ وارد شوید.");

    // ردیف مهمانِ همین شماره با آخرین امضا (در صورت نبودنِ امضا: هر مهمانِ همین شماره)
    const [bySign] = await db
      .select({ id: users.id })
      .from(contractSigners)
      .innerJoin(users, eq(users.id, contractSigners.userId))
      .where(and(eq(users.mobile, mobile), eq(users.isGuest, true), eq(contractSigners.status, "signed")))
      .orderBy(desc(contractSigners.signedAt))
      .limit(1);
    const guestId = bySign?.id ?? (await db.select({ id: users.id }).from(users).where(and(eq(users.mobile, mobile), eq(users.isGuest, true))).orderBy(desc(users.id)).limit(1))[0]?.id;

    let userId: number;
    if (guestId) {
      try {
        ({ userId } = await upgradeGuestToUser(guestId, { email: input.email, passwordHash: input.passwordHash, verifiedMobile: mobile }));
      } catch (e) {
        if (e instanceof GuestUpgradeError) throw new VaultUpgradeError(e.code === "email_taken" ? "با این ایمیل قبلاً ثبت‌نام شده است. وارد شوید یا رمز را بازیابی کنید." : e.message);
        throw e;
      }
    } else {
      const [clash] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email));
      if (clash) throw new VaultUpgradeError("با این ایمیل قبلاً ثبت‌نام شده است. وارد شوید یا رمز را بازیابی کنید.");
      const [created] = await db.insert(users).values({ name: (input.name || "").trim() || "کاربر", email: input.email, mobile, passwordHash: input.passwordHash, role: "user" }).returning({ id: users.id });
      userId = created.id;
    }
    const patch: Partial<typeof users.$inferInsert> = { emailVerifiedAt: emailVerificationRequired() ? null : new Date() };
    if (input.name && input.name.trim().length >= 3) patch.name = input.name.trim().slice(0, 100);
    await db.update(users).set(patch).where(eq(users.id, userId));

    const workspaceId = await createWorkspace(userId, input.workspaceName);
    await db
      .insert(vaultProfiles)
      .values({ mobile, source: "direct", upgradedUserId: userId, upgradedAt: new Date(), referrerUserId: touch?.referrerUserId ?? null, attributedContractId: touch?.contractId ?? null })
      .onConflictDoUpdate({ target: vaultProfiles.mobile, set: { upgradedUserId: userId, upgradedAt: new Date(), referrerUserId: touch?.referrerUserId ?? null, attributedContractId: touch?.contractId ?? null } });
    await logAudit({ action: "vault.upgraded", userId, workspaceId, detail: touch ? `از طریق فرستنده #${touch.referrerUserId} (قرارداد #${touch.contractId})` : "بدون فرستنده‌ی منتسب" });
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    return { user, workspaceId };
  });

  // پاداش دوطرفه با موتور موجود دعوت: دعوت‌کننده = فرستنده‌ی اولین سند. خطا هرگز ساخت حساب را مختل نمی‌کند.
  let rewarded = false;
  if (touch) {
    try {
      const code = await getOrCreateCode(touch.referrerUserId);
      const r = await attachReferral({ code, referred: { id: out.user.id, mobile }, workspaceId: out.workspaceId, ip: input.ip });
      rewarded = r.ok;
    } catch {
      rewarded = false;
    }
  }
  return { ...out, rewarded };
}

/* ───────── گزارش قیف رشد برای مدیر کل ───────── */
export async function vaultFunnel() {
  const [a] = await db
    .select({ n: sql<number>`count(distinct ${users.mobile})::int` })
    .from(contractSigners)
    .innerJoin(users, eq(users.id, contractSigners.userId))
    .where(and(eq(contractSigners.status, "signed"), isNotNull(contractSigners.otpVerifiedAt), sql`${users.mobile} <> ''`));
  const [p] = await db
    .select({
      vault: sql<number>`count(*)::int`,
      returning: sql<number>`count(*) filter (where ${vaultProfiles.visits} > 1)::int`,
      upgraded: sql<number>`count(*) filter (where ${vaultProfiles.upgradedUserId} is not null)::int`,
      fromSign: sql<number>`count(*) filter (where ${vaultProfiles.source} = 'sign')::int`,
    })
    .from(vaultProfiles);
  // «فعال‌شده»: حسابِ ساخته‌شده از کیف که حداقل یک قرارداد واقعی (غیرپیش‌نویس) صادر کرده است
  const [q] = await db
    .select({ n: sql<number>`count(distinct ${vaultProfiles.id})::int` })
    .from(vaultProfiles)
    .innerJoin(contracts, eq(contracts.createdBy, vaultProfiles.upgradedUserId))
    .where(sql`${contracts.status} <> 'draft'`);
  return { signers: a?.n ?? 0, vault: p?.vault ?? 0, returning: p?.returning ?? 0, fromSign: p?.fromSign ?? 0, upgraded: p?.upgraded ?? 0, activated: q?.n ?? 0 };
}

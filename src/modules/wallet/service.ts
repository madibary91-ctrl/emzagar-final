import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { walletTransactions, wallets } from "@/db/schema";
import { packById } from "./packs";

/**
 * هسته‌ی کیف پول: همه‌ی تغییرات از یک تابع اتمی می‌گذرند.
 *  - موجودی در همان UPDATE بررسی می‌شود (WHERE موجودی + تغییر >= 0)، پس هیچ‌گاه منفی نمی‌شود، حتی با درخواست‌های موازی.
 *  - هر تغییر یک ردیف در دفتر کل دارد؛ کلید یکتای `ref` از ثبت دوباره‌ی همان رویداد (مثلاً بازگشت مجدد از درگاه) جلوگیری می‌کند.
 *  - اگر هر مرحله شکست بخورد، کل تراکنش برگردانده می‌شود.
 */
/** مجری پرسش: خود db یا یک تراکنش در جریان (برای اینکه شارژ کیف پول بخشی از تراکنشِ بزرگ‌تر شود) */
export type DbExecutor = Pick<typeof db, "transaction">;

export type Asset = "toman" | "credits";
export type WalletOp = { asset: Asset; delta: number; kind: string; ref?: string; description?: string; userId?: number | null };
export type WalletResult = { ok: true; balance: number; credits: number } | { ok: false; reason: "insufficient" | "duplicate" | "invalid" };

class Abort extends Error {
  constructor(readonly reason: "insufficient" | "duplicate") {
    super(reason);
  }
}

export async function applyWalletOps(workspaceId: number, ops: WalletOp[], exec: DbExecutor = db): Promise<WalletResult> {
  if (!Number.isInteger(workspaceId) || workspaceId <= 0 || ops.length === 0) return { ok: false, reason: "invalid" };
  if (ops.some((o) => !Number.isSafeInteger(o.delta) || o.delta === 0)) return { ok: false, reason: "invalid" };
  try {
    // اگر exec یک تراکنش باشد، این بلوک یک SAVEPOINT است: شکستِ آن فقط خودش را برمی‌گرداند و تراکنش بیرونی دست‌نخورده می‌ماند
    return await exec.transaction(async (tx) => {
      await tx.insert(wallets).values({ workspaceId }).onConflictDoNothing();
      let last = { balance: 0, credits: 0 };
      for (const op of ops) {
        const col = op.asset === "toman" ? wallets.balance : wallets.credits;
        const next = sql`${col} + ${op.delta}`;
        const [row] = await tx
          .update(wallets)
          .set(op.asset === "toman" ? { balance: next, updatedAt: new Date() } : { credits: next, updatedAt: new Date() })
          .where(and(eq(wallets.workspaceId, workspaceId), sql`${col} + ${op.delta} >= 0`))
          .returning({ balance: wallets.balance, credits: wallets.credits });
        if (!row) throw new Abort("insufficient");
        const ins = await tx
          .insert(walletTransactions)
          .values({
            workspaceId,
            userId: op.userId ?? null,
            asset: op.asset,
            kind: op.kind,
            amount: op.delta,
            balanceAfter: op.asset === "toman" ? row.balance : row.credits,
            ref: op.ref ?? null,
            description: (op.description ?? "").slice(0, 200),
          })
          .onConflictDoNothing()
          .returning({ id: walletTransactions.id });
        if (ins.length === 0) throw new Abort("duplicate");
        last = row;
      }
      return { ok: true as const, balance: Number(last.balance), credits: Number(last.credits) };
    });
  } catch (e) {
    if (e instanceof Abort) return { ok: false, reason: e.reason };
    throw e;
  }
}

export async function getWallet(workspaceId: number): Promise<{ balance: number; credits: number }> {
  const [row] = await db.select().from(wallets).where(eq(wallets.workspaceId, workspaceId));
  return { balance: Number(row?.balance ?? 0), credits: row?.credits ?? 0 };
}

export async function listWalletTransactions(workspaceId: number, limit = 40) {
  return db.select().from(walletTransactions).where(eq(walletTransactions.workspaceId, workspaceId)).orderBy(desc(walletTransactions.id)).limit(limit);
}

/** شارژ ریالی کیف پول (مثلاً پس از تایید پرداخت درگاه). ref یکتا است: تایید دوباره، دوبار شارژ نمی‌کند. */
export async function creditToman(workspaceId: number, amount: number, o: { kind: string; ref: string; description: string; userId?: number | null; exec?: DbExecutor }): Promise<WalletResult> {
  return applyWalletOps(workspaceId, [{ asset: "toman", delta: Math.round(amount), kind: o.kind, ref: o.ref, description: o.description, userId: o.userId }], o.exec);
}

/** هدیه‌ی اعتبار قرارداد (پاداش دعوت و …) */
export async function grantCredits(workspaceId: number, credits: number, o: { kind: string; ref: string; description: string; userId?: number | null }): Promise<WalletResult> {
  return applyWalletOps(workspaceId, [{ asset: "credits", delta: Math.round(credits), kind: o.kind, ref: o.ref, description: o.description, userId: o.userId }]);
}

/** خرید بسته‌ی اعتباری از موجودی کیف پول؛ کسر موجودی و افزایش اعتبار در یک تراکنش اتمی */
export async function purchasePack(workspaceId: number, userId: number, packId: string): Promise<{ ok: true; credits: number } | { ok: false; error: string }> {
  const pack = packById(packId);
  if (!pack) return { ok: false, error: "بسته‌ی انتخاب‌شده معتبر نیست" };
  const ref = `pack:${crypto.randomUUID()}`;
  const r = await applyWalletOps(workspaceId, [
    { asset: "toman", delta: -pack.priceToman, kind: "pack_purchase", ref, description: pack.name, userId },
    { asset: "credits", delta: pack.credits, kind: "pack_purchase", ref: `${ref}:credits`, description: pack.name, userId },
  ]);
  if (!r.ok) return { ok: false, error: r.reason === "insufficient" ? "موجودی کیف پول کافی نیست؛ ابتدا کیف پول را شارژ کنید." : "خرید انجام نشد؛ دوباره تلاش کنید." };
  return { ok: true, credits: r.credits };
}

/** مصرف اعتبار برای صدور قرارداد؛ در صورت خطای بعدی با release() برگردانده می‌شود */
export async function consumeCredits(workspaceId: number, count: number): Promise<{ ok: boolean; release: () => Promise<void> }> {
  const ref = `use:${crypto.randomUUID()}`;
  const r = await applyWalletOps(workspaceId, [{ asset: "credits", delta: -count, kind: "credit_use", ref, description: `صدور ${count} قرارداد بالاتر از سقف ماهانه` }]);
  if (!r.ok) return { ok: false, release: async () => undefined };
  let released = false;
  return {
    ok: true,
    release: async () => {
      if (released) return;
      released = true;
      await applyWalletOps(workspaceId, [{ asset: "credits", delta: count, kind: "credit_refund", ref: `${ref}:refund`, description: "بازگشت اعتبار (صدور قرارداد انجام نشد)" }]).catch(() => undefined);
    },
  };
}

/** آمار کل برای مدیر پلتفرم: مجموع موجودی (بدهی پلتفرم به کاربران) و اعتبارهای مصرف‌نشده */
export async function walletTotals() {
  const [r] = await db.select({ balance: sql<number>`coalesce(sum(${wallets.balance}),0)::bigint`, credits: sql<number>`coalesce(sum(${wallets.credits}),0)::bigint`, n: sql<number>`count(*)::int` }).from(wallets);
  return { balance: Number(r?.balance ?? 0), credits: Number(r?.credits ?? 0), wallets: r?.n ?? 0 };
}

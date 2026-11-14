import { and, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { zipSync, strToU8 } from "fflate";
import { db } from "@/db";
import { contracts, contractSigners, users, vaultPrefs, vaultProfiles, workspaces } from "@/db/schema";
import { getGlobalSetting } from "@/modules/settings/service";
import { stageOf } from "@/modules/signing/stages";
import { getContractPdf, PdfTamperedError } from "@/modules/pdf/service";

/**
 * ── کیف اسناد امضاکننده (Signer Vault) ───────────────────────────────────────
 *
 * تصمیم معماری: هویت کیف «موبایل تأییدشده» است، نه یک ردیف users. مهمان‌ها به‌ازای هر فضای کاری یک ردیف users جدا
 * دارند (ایزولاسیون فضای کاری)، اما یک انسان واقعی فقط یک شماره دارد؛ پس کیف همه‌ی ردیف‌های همان شماره را در
 * «همه‌ی فضاهای کاری» یک‌جا نشان می‌دهد، بی‌آنکه ایزولاسیون پایین‌دست (فرستنده‌ها از هم، یا از مهمان) را بشکند.
 *
 * قاعده‌ی تعلق سند به کیف (جلوگیری از نشت به کسی که فقط شماره‌ای را در پروفایل خودش نوشته):
 *   ردیف امضاکننده‌ای که user.mobile = M دارد و (کاربر مهمان است — هویتش فقط همین موبایل است —
 *   یا خودش با OTP پیامکی امضا کرده — otp_verified_at — یا همین کیف او را از مهمان به حساب واقعی ارتقا داده است).
 */
export async function isVaultEnabled(): Promise<boolean> {
  if (process.env.VAULT_ENABLED === "0") return false;
  return (await getGlobalSetting("vault_enabled")) !== "0";
}

export type VaultBucket = "action" | "waiting" | "done" | "closed";

export interface VaultParty {
  label: string;
  name: string;
  status: string;
  position: number;
  stage: number;
}

export interface VaultDoc {
  id: number;
  number: string;
  title: string;
  status: string;
  bucket: VaultBucket;
  /** نوبت امضای من رسیده است؟ */
  myTurn: boolean;
  myLabel: string;
  issuedAt: string;
  mySignedAt: string | null;
  finalAt: string | null;
  termEndsAt: string | null;
  sender: string;
  quick: boolean;
  parties: VaultParty[];
  pinned: boolean;
  archived: boolean;
  note: string;
}

/** ردیفی که همین کیف از مهمان به حساب واقعی ارتقایش داده است: هویتش با OTP همین موبایل ثابت شده، پس همه‌ی اسنادش (حتی منتظر امضا) در کیف می‌ماند */
const upgradedFromHere = (mobile: string) =>
  sql`exists (select 1 from ${vaultProfiles} vp where vp.mobile = ${mobile} and vp.upgraded_user_id = ${users.id})`;

const eligible = (mobile: string) =>
  and(eq(users.mobile, mobile), ne(contracts.status, "draft"), or(eq(users.isGuest, true), isNotNull(contractSigners.otpVerifiedAt), upgradedFromHere(mobile)));

function bucketOf(c: { status: string; expiresAt: Date | null }, mine: { status: string }, myTurn: boolean): VaultBucket {
  if (c.status === "signed") return "done";
  if (["rejected", "cancelled", "expired"].includes(c.status) || mine.status === "rejected") return "closed";
  if (c.expiresAt && c.expiresAt < new Date()) return "closed";
  if (mine.status === "pending" && myTurn) return "action";
  return "waiting";
}

/** همه‌ی اسناد کیف یک موبایل (جدیدترین اول)، همراه با وضعیت شخصی‌سازی‌شده */
export async function listVaultDocs(mobile: string): Promise<VaultDoc[]> {
  const rows = await db
    .select({ signer: contractSigners, contract: contracts, wsName: workspaces.name, wsKind: workspaces.kind })
    .from(contractSigners)
    .innerJoin(users, eq(users.id, contractSigners.userId))
    .innerJoin(contracts, eq(contracts.id, contractSigners.contractId))
    .innerJoin(workspaces, eq(workspaces.id, contracts.workspaceId))
    .where(eligible(mobile))
    .orderBy(desc(contracts.issuedAt))
    .limit(500);
  if (rows.length === 0) return [];

  // یک سند ممکن است دو ردیف داشته باشد (دو هویت با یک شماره)؛ ردیفِ منتظر امضا ارجح است
  const byContract = new Map<number, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = byContract.get(r.contract.id);
    if (!prev || (prev.signer.status !== "pending" && r.signer.status === "pending")) byContract.set(r.contract.id, r);
  }
  const picked = [...byContract.values()];
  const ids = picked.map((r) => r.contract.id);

  const others = await db
    .select({ contractId: contractSigners.contractId, position: contractSigners.position, stage: contractSigners.stage, label: contractSigners.label, status: contractSigners.status, name: users.name })
    .from(contractSigners)
    .innerJoin(users, eq(users.id, contractSigners.userId))
    .where(inArray(contractSigners.contractId, ids))
    .orderBy(contractSigners.position);
  const partiesBy = new Map<number, VaultParty[]>();
  for (const o of others) {
    const list = partiesBy.get(o.contractId) ?? [];
    list.push({ label: o.label, name: o.name, status: o.status, position: o.position, stage: o.stage });
    partiesBy.set(o.contractId, list);
  }
  const prefs = await db.select().from(vaultPrefs).where(and(eq(vaultPrefs.mobile, mobile), inArray(vaultPrefs.contractId, ids)));
  const prefBy = new Map(prefs.map((p) => [p.contractId, p]));

  const docs = picked.map((r): VaultDoc => {
    const parties = partiesBy.get(r.contract.id) ?? [];
    const myTurn = !parties.some((p) => stageOf(p) < stageOf(r.signer) && p.status === "pending");
    const pref = prefBy.get(r.contract.id);
    const quick = r.wsKind === "quick";
    return {
      id: r.contract.id,
      number: r.contract.number,
      title: r.contract.title,
      status: r.contract.status,
      bucket: bucketOf(r.contract, r.signer, myTurn),
      myTurn,
      myLabel: r.signer.label,
      issuedAt: r.contract.issuedAt.toISOString(),
      mySignedAt: r.signer.signedAt ? r.signer.signedAt.toISOString() : null,
      finalAt: r.contract.signedAt ? r.contract.signedAt.toISOString() : null,
      termEndsAt: r.contract.termEndsAt ? r.contract.termEndsAt.toISOString() : null,
      // نام کسب‌وکار فرستنده؛ برای «ارسال سریع» فضای کاری سیستمی است و نامی از آن نمایش داده نمی‌شود
      sender: quick ? "" : r.wsName,
      quick,
      parties,
      pinned: pref?.pinned ?? false,
      archived: pref?.archived ?? false,
      note: pref?.note ?? "",
    };
  });
  // سنجاق‌شده‌ها و «منتظر امضای من» بالا
  return docs.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.bucket === "action") - Number(a.bucket === "action") || b.issuedAt.localeCompare(a.issuedAt));
}

export interface VaultStats {
  total: number;
  signed: number;
  action: number;
  waiting: number;
  senders: number;
  /** قراردادهایی که تا ۶۰ روز دیگر پایان مدت دارند */
  expiringSoon: number;
}

export function vaultStats(docs: VaultDoc[]): VaultStats {
  const now = Date.now();
  return {
    total: docs.length,
    signed: docs.filter((d) => d.bucket === "done").length,
    action: docs.filter((d) => d.bucket === "action").length,
    waiting: docs.filter((d) => d.bucket === "waiting").length,
    senders: new Set(docs.filter((d) => !d.quick && d.sender).map((d) => d.sender)).size,
    expiringSoon: docs.filter((d) => d.bucket === "done" && d.termEndsAt && new Date(d.termEndsAt).getTime() > now && new Date(d.termEndsAt).getTime() < now + 60 * 86400_000).length,
  };
}

/** آیا این قرارداد متعلق به کیف این موبایل است؟ (مرز دسترسی همه‌ی عملیات) */
export async function getVaultAccess(mobile: string, contractId: number) {
  if (!Number.isInteger(contractId) || contractId <= 0) return null;
  const rows = await db
    .select({ signer: contractSigners, contract: contracts })
    .from(contractSigners)
    .innerJoin(users, eq(users.id, contractSigners.userId))
    .innerJoin(contracts, eq(contracts.id, contractSigners.contractId))
    .where(and(eligible(mobile), eq(contracts.id, contractId)))
    .limit(5);
  if (rows.length === 0) return null;
  return rows.find((r) => r.signer.status === "pending") ?? rows[0];
}

export async function setVaultPref(mobile: string, contractId: number, patch: { pinned?: boolean; archived?: boolean; note?: string }): Promise<boolean> {
  if (!(await getVaultAccess(mobile, contractId))) return false;
  const set: Partial<typeof vaultPrefs.$inferInsert> = { updatedAt: new Date() };
  if (typeof patch.pinned === "boolean") set.pinned = patch.pinned;
  if (typeof patch.archived === "boolean") set.archived = patch.archived;
  if (typeof patch.note === "string") set.note = patch.note.replace(/[\u0000-\u001f\u007f\u202a-\u202e]/g, " ").trim().slice(0, 500);
  await db
    .insert(vaultPrefs)
    .values({ mobile, contractId, ...set })
    .onConflictDoUpdate({ target: [vaultPrefs.mobile, vaultPrefs.contractId], set });
  return true;
}

/** ثبت ورود به کیف (قیف رشد). نقطه‌ی ورود اول حفظ می‌شود. */
export async function touchVaultProfile(mobile: string, source: "sign" | "direct" | "quick"): Promise<void> {
  await db
    .insert(vaultProfiles)
    .values({ mobile, source })
    .onConflictDoUpdate({ target: vaultProfiles.mobile, set: { visits: sql`${vaultProfiles.visits} + 1`, lastSeenAt: new Date() } });
}

export async function hasVaultDocs(mobile: string): Promise<boolean> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contractSigners)
    .innerJoin(users, eq(users.id, contractSigners.userId))
    .innerJoin(contracts, eq(contracts.id, contractSigners.contractId))
    .where(eligible(mobile));
  return (r?.n ?? 0) > 0;
}

/** PDF رسمی یک سند نهایی‌شده (فقط اگر به کیف تعلق دارد) */
export async function vaultPdf(mobile: string, contractId: number) {
  const access = await getVaultAccess(mobile, contractId);
  if (!access || access.contract.status !== "signed") return null;
  return { contract: access.contract, pdf: await getContractPdf(contractId) };
}

const MAX_ZIP_DOCS = 60;

/** همه‌ی اسناد نهایی‌شده در یک فایل ZIP (به‌همراه فهرست و هش هر سند برای راستی‌آزمایی) */
export async function vaultZip(mobile: string): Promise<{ buffer: Buffer; count: number; skipped: number }> {
  const docs = (await listVaultDocs(mobile)).filter((d) => d.bucket === "done").slice(0, MAX_ZIP_DOCS);
  const files: Record<string, Uint8Array> = {};
  const index: string[] = ["فهرست اسناد کیف اسناد امضاگیر", "====================================", ""];
  let skipped = 0;
  for (const d of docs) {
    try {
      const pdf = await getContractPdf(d.id);
      files[`${d.number}.pdf`] = new Uint8Array(pdf.buffer);
      index.push(`${d.number} | ${d.title} | SHA-256: ${pdf.sha256}`);
    } catch (e) {
      skipped++;
      if (!(e instanceof PdfTamperedError)) console.error("[vault:zip]", e);
    }
  }
  files["index.txt"] = strToU8(index.join("\n"));
  return { buffer: Buffer.from(zipSync(files, { level: 0 })), count: docs.length - skipped, skipped };
}

/** نام نمایشی صاحب کیف (آخرین نامی که با این شماره امضا شده) */
export async function vaultDisplayName(mobile: string): Promise<string> {
  const [u] = await db.select({ name: users.name }).from(users).where(and(eq(users.mobile, mobile), eq(users.isGuest, true))).orderBy(desc(users.id)).limit(1);
  return u?.name ?? "";
}

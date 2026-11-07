import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contractAmendments, contracts, workspaces } from "@/db/schema";
import { docFingerprint } from "@/modules/signing/fingerprint";
import { getFieldValues } from "@/modules/fields/service";
import { getSigners } from "@/modules/contracts/service";

/** نام را ماسک می‌کند تا در صفحه‌ی عمومی هویت کامل افراد فاش نشود: «علی رضایی» ← «علی ر•••» */
export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return `${parts[0].slice(0, 1)}•••`;
  return `${parts[0]} ${parts.slice(1).map((p) => `${p.slice(0, 1)}•••`).join(" ")}`;
}

export const isDocHash = (h: string) => /^[a-f0-9]{64}$/.test(h);

export type VerifyOutcome = {
  found: true;
  number: string;
  title: string;
  workspaceName: string;
  signedAt: Date | null;
  /** آیا متن و امضاهای فعلی دقیقاً با اثر انگشت ثبت‌شده در زمان امضا برابرند؟ */
  intact: boolean;
  signers: { label: string; name: string; signedAt: Date | null }[];
  /** نسخه‌ی فعلی قرارداد (۱ + الحاقیه‌های تأییدشده) و فهرست الحاقیه‌ها */
  version: number;
  amendments: { seq: number; title: string; signedAt: Date | null; hash: string }[];
} | { found: false };

/** استعلام عمومی اصالت سند با اثر انگشت (SHA-256). فقط قراردادهای کاملاً امضاشده؛ متن قرارداد هرگز نمایش داده نمی‌شود. */
export async function verifyDocument(hash: string): Promise<VerifyOutcome> {
  if (!isDocHash(hash)) return { found: false };
  const [c] = await db.select().from(contracts).where(and(eq(contracts.docHash, hash), eq(contracts.status, "signed")));
  if (!c) return { found: false };
  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, c.workspaceId));
  const signers = await getSigners(c.id);
  // همان فرمول لحظه‌ی امضای نهایی (modules/signing/actions.ts)
  const recomputed = docFingerprint(c.bodyHtml, signers, await getFieldValues(c.id));
  const amends = (await db.select().from(contractAmendments).where(and(eq(contractAmendments.contractId, c.id), eq(contractAmendments.status, "signed")))).sort((a, b) => a.seq - b.seq);
  return {
    found: true,
    number: c.number,
    title: c.title,
    workspaceName: ws?.name ?? "",
    signedAt: c.signedAt,
    intact: recomputed === hash,
    signers: signers.map((s) => ({ label: s.label, name: maskName(s.userName), signedAt: s.signedAt })),
    version: 1 + amends.length,
    amendments: amends.map((a) => ({ seq: a.seq, title: a.title, signedAt: a.signedAt, hash: a.docHash ?? "" })),
  };
}

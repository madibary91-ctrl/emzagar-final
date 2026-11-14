import { type IdentityReq, parseIdentityReq } from "../rules";
import { contractSigners, signerIdentities, users } from "@/db/schema";
import { db } from "@/db";
import { decryptSecret } from "@/lib/crypto";
import { desc, eq, sql } from "drizzle-orm";
import { requirementMet } from "./core";

/* ───────── گزارش‌ها و نمای صادرکننده ───────── */

export type AdminIdentity = {
  signerId: number;
  req: IdentityReq;
  met: boolean;
  shahkar: string;
  shahkarProvider: string;
  shahkarAt: Date | null;
  attempts: number;
  expectedNc: string;
  nc: string;
  docStatus: string;
  docSubmittedAt: Date | null;
  docRejectReason: string;
  hasDocs: boolean;
  sealHash: string;
  assurance: string;
};
export async function listIdentityForContract(contractId: number): Promise<Map<number, AdminIdentity>> {
  const signers = await db
    .select({ id: contractSigners.id, req: contractSigners.identityReq, assurance: contractSigners.identityAssurance, userMobile: users.mobile })
    .from(contractSigners)
    .innerJoin(users, eq(users.id, contractSigners.userId))
    .where(eq(contractSigners.contractId, contractId));
  const rows = await db.select().from(signerIdentities).where(eq(signerIdentities.contractId, contractId)).orderBy(desc(signerIdentities.id));
  const out = new Map<number, AdminIdentity>();
  for (const s of signers) {
    const r = rows.find((x) => x.signerId === s.id) ?? null;
    const req = parseIdentityReq(s.req);
    if (req === "none" && !r && s.assurance === "none") continue;
    out.set(s.id, {
      signerId: s.id,
      req,
      met: requirementMet(req, r, s.userMobile),
      shahkar: r?.shahkarStatus === "matched" && r.checkedMobile !== s.userMobile ? "stale" : (r?.shahkarStatus ?? "none"),
      shahkarProvider: r?.shahkarProvider ?? "",
      shahkarAt: r?.shahkarAt ?? null,
      attempts: r?.attempts ?? 0,
      expectedNc: r?.expectedNcEnc ? decryptSecret(r.expectedNcEnc) : "",
      nc: r?.ncEnc ? decryptSecret(r.ncEnc) : "",
      docStatus: r?.docStatus ?? "none",
      docSubmittedAt: r?.docSubmittedAt ?? null,
      docRejectReason: r?.docRejectReason ?? "",
      hasDocs: !!(r?.idFile && r?.selfieFile),
      sealHash: r?.sealHash ?? "",
      assurance: s.assurance,
    });
  }
  return out;
}
/** برای شناسنامه‌ی PDF و استعلام عمومی: سطح تضمین هر امضاکننده + مهر */
export async function assuranceForContract(contractId: number): Promise<Map<number, { assurance: string; sandbox: boolean; seal: string }>> {
  const rows = await db
    .select({ id: contractSigners.id, assurance: contractSigners.identityAssurance, provider: signerIdentities.shahkarProvider, seal: signerIdentities.sealHash })
    .from(contractSigners)
    .leftJoin(signerIdentities, eq(signerIdentities.signerId, contractSigners.id))
    .where(eq(contractSigners.contractId, contractId));
  return new Map(rows.filter((r) => r.assurance && r.assurance !== "none").map((r) => [r.id, { assurance: r.assurance, sandbox: r.provider === "sandbox", seal: r.seal ?? "" }]));
}
export async function identityCounts() {
  const r = await db.execute(sql`
    select
      count(*) filter (where verified_at is not null)::int as verified,
      count(*) filter (where shahkar_status = 'mismatch')::int as mismatch,
      count(*) filter (where doc_status = 'pending')::int as pending_docs,
      count(*) filter (where seal_hash is not null)::int as sealed
    from signer_identities`);
  const x = (r.rows[0] ?? {}) as Record<string, number>;
  return { verified: x.verified ?? 0, mismatch: x.mismatch ?? 0, pendingDocs: x.pending_docs ?? 0, sealed: x.sealed ?? 0 };
}

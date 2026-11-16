import { asc, eq } from "drizzle-orm";
import { contractInstallments } from "@/db/schema";
import crypto from "node:crypto";
import { db } from "@/db";

export type Installment = typeof contractInstallments.$inferSelect;
export class PayError extends Error {}
export const newCode = () => crypto.randomBytes(18).toString("base64url");
export const PAY_CODE_RE = /^[A-Za-z0-9_-]{20,40}$/;
export const dueDate = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`) : null);
export async function listInstallments(contractId: number): Promise<Installment[]> {
  return db.select().from(contractInstallments).where(eq(contractInstallments.contractId, contractId)).orderBy(asc(contractInstallments.position), asc(contractInstallments.id));
}

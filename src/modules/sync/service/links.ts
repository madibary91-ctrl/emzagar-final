import { type Conn, clean, int } from "./util";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { wcContractLinks } from "@/db/schema";

/* ───────────── پیوند قرارداد ↔ سفارش ───────────── */

export type ExternalRef = { source: "woocommerce"; orderId: number; productId: number; key: string };
export function parseExternal(raw: unknown): ExternalRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = clean(r.key, 80);
  if (r.source !== "woocommerce" || !/^[A-Za-z0-9_.:-]{3,80}$/.test(key)) return null;
  return { source: "woocommerce", orderId: int(r.orderId), productId: int(r.productId), key };
}
export async function findLinkByKey(connectionId: number, key: string) {
  const [l] = await db.select().from(wcContractLinks).where(and(eq(wcContractLinks.connectionId, connectionId), eq(wcContractLinks.externalKey, key)));
  return l ?? null;
}
export async function createLink(c: Conn, contractId: number, ref: ExternalRef) {
  await db
    .insert(wcContractLinks)
    .values({ workspaceId: c.workspaceId, connectionId: c.id, contractId, wcOrderId: ref.orderId, wcProductId: ref.productId, externalKey: ref.key })
    .onConflictDoNothing();
}

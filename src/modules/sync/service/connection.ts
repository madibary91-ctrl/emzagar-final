import { type Conn, clean } from "./util";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { logAudit } from "@/modules/audit/service";
import { newSyncSecret } from "../sign";
import { wpConnections } from "@/db/schema";

/* ───────────── اتصال و راز مشترک ───────────── */

export async function connectionByKey(keyId: number): Promise<Conn | null> {
  const [c] = await db.select().from(wpConnections).where(and(eq(wpConnections.apiKeyId, keyId), eq(wpConnections.status, "active")));
  return c ?? null;
}
export function secretOf(c: Conn): string {
  return decryptSecret(c.syncSecret);
}
/** دست‌دادن همگام‌سازی: اگر راز نبود (یا rotate) ساخته می‌شود؛ قابلیت‌های افزونه ثبت می‌گردد */
export async function syncHandshake(c: Conn, opts: { rotate?: boolean; capabilities?: string } = {}) {
  let secret = secretOf(c);
  let at = c.syncSecretAt;
  if (!secret || opts.rotate) {
    secret = newSyncSecret();
    at = new Date();
  }
  const caps = clean(opts.capabilities, 200)
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^[a-z_]{2,20}$/.test(x))
    .join(",");
  await db
    .update(wpConnections)
    .set({ syncSecret: encryptSecret(secret), syncSecretAt: at, capabilities: caps || c.capabilities, lastSeenAt: new Date() })
    .where(eq(wpConnections.id, c.id));
  return { secret, secretAt: Math.floor((at ?? new Date()).getTime() / 1000) };
}
export async function rotateSyncSecret(workspaceId: number, connId: number) {
  const [c] = await db.select().from(wpConnections).where(and(eq(wpConnections.id, connId), eq(wpConnections.workspaceId, workspaceId)));
  if (!c) return false;
  await syncHandshake(c, { rotate: true });
  await logAudit({ action: "apikey.created", workspaceId, detail: `چرخش راز همگام‌سازی ${c.siteHost}`, actor: "wp-sync" });
  return true;
}
export async function setSyncEnabled(workspaceId: number, connId: number, enabled: boolean) {
  await db.update(wpConnections).set({ syncEnabled: enabled }).where(and(eq(wpConnections.id, connId), eq(wpConnections.workspaceId, workspaceId)));
}

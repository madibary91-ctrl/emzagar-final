import { collectCampaigns, collectSubmissions } from "@/db/schema";
import crypto from "node:crypto";
import { getAllSettings } from "@/modules/settings/service";
import { getOrigin } from "@/lib/request";
import { getSecret } from "@/lib/secret";

export class CollectError extends Error {}
export type Campaign = typeof collectCampaigns.$inferSelect;
export type Submission = typeof collectSubmissions.$inferSelect;
export const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const RECEIPT_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const rand = (alphabet: string, n: number) => Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
export const MAX_BODY = 200_000;
export const textLen = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().length;
export const accessKey = (receipt: string) => crypto.createHmac("sha256", getSecret()).update(`collect-receipt:${receipt}`).digest("hex").slice(0, 32);
export const RECEIPT_RE = /^[A-Z2-9]{10}$/;
export const CODE_RE = /^[a-z2-9]{8}$/;
export async function publicBase(workspaceId: number): Promise<string> {
  const cfg = await getAllSettings(workspaceId);
  return (cfg.app_url || (await getOrigin().catch(() => process.env.APP_URL || ""))).replace(/\/+$/, "");
}

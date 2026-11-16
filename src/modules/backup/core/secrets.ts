import { type BackupManifest, SEAL_ALG } from "./types";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

/* ───────── کلید بازیابی و مهر و موم رازها (sealed box) ───────── */
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const PRIV_PREFIX = "emz-rk1-";
const pubObj = (raw: Buffer) => crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
const privObj = (raw: Buffer) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" });
function parsePublic(b64: string): Buffer {
  const raw = Buffer.from(b64.trim(), "base64url");
  if (raw.length !== 32) throw new Error("کلید عمومی بازیابی نامعتبر است");
  return raw;
}
function parsePrivate(text: string): Buffer {
  const t = text.trim();
  const raw = Buffer.from(t.startsWith(PRIV_PREFIX) ? t.slice(PRIV_PREFIX.length) : t, "base64url");
  if (raw.length !== 32) throw new Error("کلید بازیابی نامعتبر است");
  return raw;
}
/** اثر انگشت کوتاه و قابل‌خواندن کلید عمومی: «A1B2-C3D4-E5F6-0718» */
export function recoveryFingerprint(publicKey: string): string {
  const h = crypto.createHash("sha256").update(parsePublic(publicKey)).digest("hex").slice(0, 16).toUpperCase();
  return h.match(/.{4}/g)!.join("-");
}
/** جفت‌کلید بازیابی؛ publicKey روی سرور می‌ماند، privateKey فقط یک بار به مالک نشان داده می‌شود */
export function generateRecoveryKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const pub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const priv = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
  return { publicKey: Buffer.from(pub).toString("base64url"), privateKey: PRIV_PREFIX + Buffer.from(priv).toString("base64url") };
}
function sealKey(shared: Buffer, epk: Buffer, rpk: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([epk, rpk]), "emz-backup-secrets-v1", 32));
}
/** مهر و موم: فقط دارنده‌ی کلید خصوصی بازیابی می‌تواند باز کند */
export function sealSecrets(payload: { sessionSecret: string }, recoveryPublicKey: string): string {
  const rpk = parsePublic(recoveryPublicKey);
  const eph = crypto.generateKeyPairSync("x25519");
  const epk = Buffer.from((eph.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
  const key = sealKey(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubObj(rpk) }), epk, rpk);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from("emz-backup-secrets-v1"));
  const ct = Buffer.concat([c.update(JSON.stringify({ v: 1, sessionSecret: payload.sessionSecret, sealedAt: new Date().toISOString() }), "utf8"), c.final()]);
  return JSON.stringify({ v: 1, alg: SEAL_ALG, epk: epk.toString("base64url"), iv: iv.toString("base64url"), tag: c.getAuthTag().toString("base64url"), ct: ct.toString("base64url") }, null, 2);
}
export function openSecrets(sealedJson: string, recoveryPrivateKey: string): { sessionSecret: string } {
  let obj: { alg: string; epk: string; iv: string; tag: string; ct: string };
  try {
    obj = JSON.parse(sealedJson);
  } catch {
    throw new Error("فایل رازهای مهر‌شده خراب است");
  }
  if (obj.alg !== SEAL_ALG) throw new Error("الگوریتم مهر و موم پشتیبانی نمی‌شود");
  try {
    const priv = parsePrivate(recoveryPrivateKey);
    const epk = Buffer.from(obj.epk, "base64url");
    const rpk = Buffer.from((crypto.createPublicKey(privObj(priv)).export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
    const key = sealKey(crypto.diffieHellman({ privateKey: privObj(priv), publicKey: pubObj(epk) }), epk, rpk);
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(obj.iv, "base64url"));
    d.setAAD(Buffer.from("emz-backup-secrets-v1"));
    d.setAuthTag(Buffer.from(obj.tag, "base64url"));
    const plain = JSON.parse(Buffer.concat([d.update(Buffer.from(obj.ct, "base64url")), d.final()]).toString("utf8")) as { sessionSecret?: string };
    if (!plain.sessionSecret) throw new Error("empty");
    return { sessionSecret: plain.sessionSecret };
  } catch {
    throw new Error("کلید بازیابی اشتباه است (یا فایل دستکاری شده است)");
  }
}
/** باز کردن رازِ مهر‌شده‌ی یک پوشه‌ی بک‌آپ (برای «تمرین بازیابی» و restore) */
export async function openBackupSecrets(backupDir: string, recoveryPrivateKey: string): Promise<{ sessionSecret: string } | null> {
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(backupDir, "manifest.json"), "utf8")) as BackupManifest;
  } catch {
    throw new Error("manifest.json خوانده نشد");
  }
  if (!manifest.secrets) return null;
  return openSecrets(await fsp.readFile(path.join(backupDir, manifest.secrets.file), "utf8"), recoveryPrivateKey);
}

import { sha256Buf } from "@/modules/pdf/hash";
import { deleteSignatureFile, saveSignatureFile } from "./storage";
import { parseSignatureDataUrl } from "./types";

/**
 * شواهد افزوده‌ی امضا: «مهر شرکتی» و «پاراف».
 * هر دو تصویر PNG هستند (همان اعتبارسنجی ساختاری امضا: امضا/CRC/ابعاد/ضد بمب فشرده‌سازی) و کنار تصویر امضا در پوشه‌ی
 * محافظت‌شده نگه‌داری می‌شوند؛ هش SHA-256 هرکدام در ردیف امضاکننده ثبت و در «اثر انگشت سند» لحاظ می‌شود.
 */
export type EvidenceKind = "seal" | "initials";

const NAME: Record<EvidenceKind, string> = { seal: "مهر شرکتی", initials: "پاراف" };

export function parseEvidenceImage(kind: EvidenceKind, dataUrl: string | null | undefined): { buffer: Buffer } | { error: string } {
  if (!dataUrl) return { error: `${NAME[kind]} ارسال نشده است` };
  const r = parseSignatureDataUrl(dataUrl);
  if ("error" in r) return { error: `تصویر ${NAME[kind]} معتبر نیست یا حجمش زیاد است` };
  return r;
}

export interface SignerRequirements {
  role: string;
  signerType: string;
  sealRequired: boolean;
  initialsRequired: boolean;
}

export interface EvidenceInput {
  seal?: string | null;
  initials?: string | null;
}

export type ParsedEvidence = { seal?: Buffer; initials?: Buffer };

/**
 * ورودی را با الزام‌های همین امضاکننده می‌سنجد (سمت سرور، مستقل از رابط کاربری).
 *  - مهر: اگر الزامی است باید باشد؛ برای امضاکننده‌ی حقوقی اختیاری است. شاهد و حقیقی مهر نمی‌زنند.
 *  - پاراف: فقط وقتی صادرکننده الزامی کرده باشد ثبت می‌شود.
 */
export function checkEvidence(req: SignerRequirements, input: EvidenceInput | undefined): { ok: true; evidence: ParsedEvidence } | { ok: false; error: string } {
  const evidence: ParsedEvidence = {};
  const sealAllowed = req.role !== "witness" && (req.sealRequired || req.signerType === "legal");
  if (input?.seal && sealAllowed) {
    const r = parseEvidenceImage("seal", input.seal);
    if ("error" in r) return { ok: false, error: r.error };
    evidence.seal = r.buffer;
  }
  if (req.sealRequired && !evidence.seal) return { ok: false, error: "برای این امضا، تصویر «مهر شرکتی» الزامی است" };

  if (input?.initials && req.initialsRequired) {
    const r = parseEvidenceImage("initials", input.initials);
    if ("error" in r) return { ok: false, error: r.error };
    evidence.initials = r.buffer;
  }
  if (req.initialsRequired && !evidence.initials) return { ok: false, error: "برای این امضا، «پاراف» الزامی است" };
  return { ok: true, evidence };
}

export interface SavedEvidence {
  sealFile: string | null;
  sealSha256: string | null;
  initialsFile: string | null;
  initialsSha256: string | null;
}

export async function saveEvidence(contractId: number, signerId: number, ev: ParsedEvidence): Promise<SavedEvidence> {
  const out: SavedEvidence = { sealFile: null, sealSha256: null, initialsFile: null, initialsSha256: null };
  const ts = Date.now();
  if (ev.seal) {
    out.sealFile = await saveSignatureFile(`c${contractId}-s${signerId}-seal-${ts}.png`, ev.seal);
    out.sealSha256 = sha256Buf(ev.seal);
  }
  if (ev.initials) {
    out.initialsFile = await saveSignatureFile(`c${contractId}-s${signerId}-init-${ts}.png`, ev.initials);
    out.initialsSha256 = sha256Buf(ev.initials);
  }
  return out;
}

export async function deleteEvidence(saved: SavedEvidence) {
  for (const f of [saved.sealFile, saved.initialsFile]) if (f) await deleteSignatureFile(f).catch(() => undefined);
}

import fs from "node:fs/promises";
import path from "node:path";
import { signaturesDir } from "@/lib/storage-paths";

/** پوشه‌ی محافظت‌شده — خارج از public و فقط از طریق مسیر احراز هویت‌شده قابل دریافت است */
const DIR_FN = signaturesDir;

function safeName(name: string) {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "");
}

export async function saveSignatureFile(name: string, buffer: Buffer): Promise<string> {
  const file = safeName(name);
  await fs.mkdir(DIR_FN(), { recursive: true });
  await fs.writeFile(path.join(DIR_FN(), file), buffer, { mode: 0o600 });
  return file;
}

export async function readSignatureFile(name: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(DIR_FN(), safeName(name)));
  } catch {
    return null;
  }
}

export async function deleteSignatureFile(name: string) {
  try {
    await fs.unlink(path.join(DIR_FN(), safeName(name)));
  } catch {
    /* ignore */
  }
}

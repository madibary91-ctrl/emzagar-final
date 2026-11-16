/**
 * وضعیت مشترک بین مرحله‌ی آماده‌سازی و لایه‌های آزمون (شناسه‌ها، کلید API، لینک امضا …).
 */
import fs from "node:fs";
import { STATE_DIR, STATE_FILE } from "./env";

export interface QaState {
  ready: boolean;
  apiKey: string;
  templateId: number;
  contractId: number; // قرارداد صادرشده برای «کاربر کیفیت»
  draftContractId: number; // پیش‌نویس (برای صفحه‌ی ویرایش)
  signToken: string;
  signUrl: string;
  shortCode: string;
  ticketId: number;
  userId: number;
  adminId: number;
  workspaceId: number;
}

export function readState(): Partial<QaState> {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Partial<QaState>;
  } catch {
    return {};
  }
}

export function saveState(patch: Partial<QaState>): Partial<QaState> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...readState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** وضعیت کامل (اگر آماده‌سازی انجام نشده باشد، خطای گویا می‌دهد) */
export function requireState(): QaState {
  const s = readState();
  if (!s.ready) throw new Error("مرحله‌ی آماده‌سازی انجام نشده؛ آزمون‌ها را با «npm run qa:<لایه>» اجرا کنید (scripts/qa.ts سرور و داده را می‌سازد).");
  return s as QaState;
}

import crypto from "node:crypto";
import { cookies } from "next/headers";
import { getSecret } from "@/lib/secret";
import { isSecureRequest } from "@/modules/auth/session";

/**
 * نشست «کیف اسناد»: هویت = شماره‌ی موبایلی که مالکیتش همین الان با OTP پیامکی (یا با نشست OTP امضا) ثابت شده است.
 * کوکی HttpOnly و HMAC‌دار است و جز موبایل و زمان انقضا چیزی در آن نیست؛ با خروج یا انقضا از کار می‌افتد.
 */
export const VAULT_COOKIE = "amz_vault";
export const VAULT_SESSION_SECONDS = 3 * 24 * 3600;

const mac = (payload: string) => crypto.createHmac("sha256", getSecret()).update(`vault:${payload}`).digest("hex");

export async function startVaultSession(mobile: string): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + VAULT_SESSION_SECONDS;
  const payload = `${mobile}.${exp}`;
  (await cookies()).set(VAULT_COOKIE, `${payload}.${mac(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: await isSecureRequest(),
    path: "/",
    maxAge: VAULT_SESSION_SECONDS,
  });
}

/** موبایل نشست فعلی یا null */
export async function readVaultSession(): Promise<string | null> {
  const raw = (await cookies()).get(VAULT_COOKIE)?.value;
  if (!raw) return null;
  const m = /^(09\d{9})\.(\d{9,12})\.([a-f0-9]{64})$/.exec(raw);
  if (!m) return null;
  const exp = Number(m[2]);
  if (!exp || exp < Date.now() / 1000) return null;
  const want = Buffer.from(mac(`${m[1]}.${m[2]}`));
  const got = Buffer.from(m[3]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return m[1];
}

export async function endVaultSession(): Promise<void> {
  (await cookies()).delete(VAULT_COOKIE);
}

import { normalizeReferralCode, REFERRAL_CODE_RE } from "@/modules/referral/config";

export const dynamic = "force-dynamic";

/**
 * لینک دعوت کوتاه: /r/EMZXXXXXX
 * کد را ۳۰ روز در کوکی نگه می‌دارد (تا کاربر بعداً هم ثبت‌نام کند، دعوت از دست نرود) و به ثبت‌نام می‌برد.
 * آدرس مقصد نسبی است تا به هدر Host (قابل جعل) وابسته نباشد.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = normalizeReferralCode((await params).code);
  const ok = REFERRAL_CODE_RE.test(code);
  const headers = new Headers({ Location: ok ? `/register?ref=${code}` : "/register", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (ok) headers.append("Set-Cookie", `amz_ref=${code}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  return new Response(null, { status: 303, headers });
}

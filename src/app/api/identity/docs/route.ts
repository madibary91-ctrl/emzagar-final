import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getRequestInfo } from "@/lib/request";
import { accountActor, guestActor } from "@/modules/identity/actor";
import { IDENTITY_FILE_MAX_BYTES } from "@/modules/identity/rules";
import { submitDocuments } from "@/modules/identity/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * ارسال مدارک هویتی امضاکننده (کارت ملی + سلفی با کارت).
 * multipart: nationalCode, idCard, selfie + («token» برای لینک امن) یا («contractId» برای کاربر حساب‌دار).
 * تصاویر پیش از ذخیره رمزنگاری می‌شوند؛ نوع فایل از روی محتوا تعیین می‌شود.
 */
export async function POST(req: Request) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > IDENTITY_FILE_MAX_BYTES * 2 + 1024 * 1024) return NextResponse.json({ ok: false, error: "حجم کل فایل‌ها زیاد است" }, { status: 413 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "درخواست نامعتبر است" }, { status: 400 });
  }
  const token = String(form.get("token") || "");
  const actor = token ? await guestActor(token) : await accountActor(Number(form.get("contractId")));
  if (!actor.ok) return NextResponse.json({ ok: false, error: actor.error }, { status: actor.status });
  const { ip } = await getRequestInfo();
  if (!rateLimit(`iddoc:signer:${actor.ctx.signerId}`, 6, 60 * 60_000).ok || !rateLimit(`iddoc:ip:${ip}`, 20, 60 * 60_000).ok) {
    return NextResponse.json({ ok: false, error: "تعداد درخواست‌ها زیاد است؛ بعداً تلاش کنید" }, { status: 429 });
  }
  const idCard = form.get("idCard");
  const selfie = form.get("selfie");
  if (!(idCard instanceof File) || !(selfie instanceof File) || idCard.size === 0 || selfie.size === 0) {
    return NextResponse.json({ ok: false, error: "هر دو عکس (کارت ملی و سلفی با کارت) لازم است" }, { status: 400 });
  }
  if (idCard.size > IDENTITY_FILE_MAX_BYTES || selfie.size > IDENTITY_FILE_MAX_BYTES) return NextResponse.json({ ok: false, error: "حجم هر عکس حداکثر ۵ مگابایت است" }, { status: 413 });
  const res = await submitDocuments(actor.ctx, {
    nationalCode: String(form.get("nationalCode") || ""),
    idCard: { name: idCard.name, buffer: Buffer.from(await idCard.arrayBuffer()) },
    selfie: { name: selfie.name, buffer: Buffer.from(await selfie.arrayBuffer()) },
  });
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}

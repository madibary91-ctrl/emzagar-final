import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getTeamForApi } from "@/modules/tenancy/context";
import { KYC_DOC_KINDS, KYC_MAX_FILE_BYTES } from "@/modules/kyc/rules";
import { submitKyc, type KycFile } from "@/modules/kyc/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** ارسال مدارک احراز هویت فضای کاری (فقط مالک/مدیر). فایل‌ها پیش از ذخیره رمزنگاری می‌شوند. */
export async function POST(req: Request) {
  const team = await getTeamForApi("settings");
  if (!team) return NextResponse.json({ ok: false, error: "دسترسی ندارید" }, { status: 401 });
  if (!rateLimit(`kyc:submit:${team.workspaceId}`, 6, 60 * 60_000).ok) return NextResponse.json({ ok: false, error: "تعداد درخواست‌ها زیاد است؛ بعداً تلاش کنید." }, { status: 429 });
  const len = Number(req.headers.get("content-length") || 0);
  if (len > KYC_MAX_FILE_BYTES * KYC_DOC_KINDS.length + 1024 * 1024) return NextResponse.json({ ok: false, error: "حجم کل فایل‌ها زیاد است" }, { status: 413 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "درخواست نامعتبر است" }, { status: 400 });
  }
  const files: KycFile[] = [];
  for (const d of KYC_DOC_KINDS) {
    const f = form.get(d.field);
    if (f instanceof File && f.size > 0) {
      if (f.size > KYC_MAX_FILE_BYTES) return NextResponse.json({ ok: false, error: `حجم «${d.label}» بیش از ۵ مگابایت است` }, { status: 413 });
      files.push({ kind: d.kind, name: f.name, buffer: Buffer.from(await f.arrayBuffer()) });
    }
  }
  const res = await submitKyc({
    workspaceId: team.workspaceId,
    userId: team.id,
    fullName: String(form.get("fullName") || ""),
    nationalCode: String(form.get("nationalCode") || ""),
    birthDate: String(form.get("birthDate") || ""),
    files,
  });
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}

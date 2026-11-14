import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getRequestInfo } from "@/lib/request";
import { hasGuestSession, resolveSigningToken } from "@/modules/signing/links";
import { downloadHeaders, listAttachments, MAX_ATTACHMENT_BYTES, readAttachment, saveAttachment, AttachmentTamperedError } from "@/modules/attachments/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** امضاکننده‌ی بدون ثبت‌نام (لینک امن + نشست OTP) */
async function guest(token: string) {
  const st = await resolveSigningToken(token);
  if (st.status !== "ok") return null;
  if (!(await hasGuestSession(st.ctx.link.id, st.ctx.signer.id))) return null;
  return st.ctx;
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await guest(token);
  if (!ctx) return NextResponse.json({ ok: false, error: "نشست تأیید هویت معتبر نیست؛ ابتدا کد پیامکی را تأیید کنید" }, { status: 401 });
  const { ip } = await getRequestInfo();
  if (!rateLimit(`gattach:link:${ctx.link.id}`, 20, 15 * 60_000).ok || !rateLimit(`gattach:ip:${ip}`, 40, 15 * 60_000).ok) {
    return NextResponse.json({ ok: false, error: "تعداد درخواست‌ها زیاد است" }, { status: 429 });
  }
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_ATTACHMENT_BYTES + 512 * 1024) return NextResponse.json({ ok: false, error: "حجم فایل بیش از ۵ مگابایت است" }, { status: 413 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "درخواست نامعتبر است" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "فایلی انتخاب نشده است" }, { status: 400 });
  const res = await saveAttachment({
    contractId: ctx.contract.id,
    uploader: { userId: ctx.user.id, label: `${ctx.signer.label} — ${ctx.user.name}` },
    title: String(form.get("title") || ""),
    originalName: file.name,
    buffer: Buffer.from(await file.arrayBuffer()),
  });
  if (!res.ok) return NextResponse.json(res, { status: 400 });
  return NextResponse.json({ ok: true, id: res.attachment.id, sha256: res.attachment.sha256 });
}

/** بدون id: فهرست پیوست‌های خود امضاکننده. با ?id=: دانلود پیوستی که خودش بارگذاری کرده است. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await guest(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    const rows = (await listAttachments(ctx.contract.id)).filter((a) => a.uploadedBy === ctx.user.id);
    return NextResponse.json({ items: rows.map((a) => ({ id: a.id, name: a.originalName, size: a.size, sha256: a.sha256, title: a.title })) });
  }
  try {
    const f = await readAttachment(ctx.contract.id, Number(id));
    if (!f || f.row.uploadedBy !== ctx.user.id) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(new Uint8Array(f.buffer), { headers: downloadHeaders(f.row) });
  } catch (e) {
    if (e instanceof AttachmentTamperedError) return NextResponse.json({ error: "integrity_check_failed" }, { status: 409 });
    throw e;
  }
}

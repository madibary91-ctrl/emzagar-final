import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/modules/auth/session";
import { getContractForUser } from "@/modules/contracts/service";
import { saveAttachment, MAX_ATTACHMENT_BYTES } from "@/modules/attachments/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** آپلود پیوست توسط کاربر واردشده‌ی دارای دسترسی به قرارداد (تیم، مشتری یا امضاکننده) */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const data = await getContractForUser(user, Number(id));
  if (!data) return NextResponse.json({ ok: false, error: "قرارداد یافت نشد یا دسترسی ندارید" }, { status: 404 });
  if (!rateLimit(`attach:user:${user.id}`, 30, 15 * 60_000).ok) return NextResponse.json({ ok: false, error: "تعداد درخواست‌ها زیاد است" }, { status: 429 });
  // سقف حجم پیش از خواندن بدنه
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
  const mine = data.signers.find((s) => s.userId === user.id);
  const label = data.teamRole ? `${user.name} (تیم)` : mine ? `${mine.label} — ${user.name}` : user.name;
  const res = await saveAttachment({
    contractId: data.contract.id,
    uploader: { userId: user.id, label },
    title: String(form.get("title") || ""),
    originalName: file.name,
    buffer: Buffer.from(await file.arrayBuffer()),
  });
  if (!res.ok) return NextResponse.json(res, { status: 400 });
  return NextResponse.json({ ok: true, id: res.attachment.id, sha256: res.attachment.sha256 });
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/modules/auth/session";
import { getContractForUser } from "@/modules/contracts/service";
import { getSource, readSourceFile } from "@/modules/docs/service";
import { fileResponse } from "@/modules/docs/http";
import { logAudit } from "@/modules/audit/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** فایل مبدأ قرارداد برای تیم و طرفین: ?v=original (فایل اصلی همان‌طور که بارگذاری شد) | work (PDF کاری، پیش‌فرض) */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const data = await getContractForUser(user, Number(id));
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const src = await getSource(data.contract.id);
  if (!src) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const url = new URL(req.url);
  const original = url.searchParams.get("v") === "original";
  const download = url.searchParams.get("dl") === "1" || original;
  try {
    if (original) {
      await logAudit({ action: "document.downloaded", contractId: data.contract.id, userId: user.id, detail: `فایل اصلی: ${src.originalName}` });
      const buf = await readSourceFile(src.originalFile, src.originalSha256);
      return fileResponse(buf, { filename: src.originalName || `${data.contract.number}.${src.kind}`, mime: src.kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    }
    return fileResponse(await readSourceFile(src.pdfFile, src.pdfSha256), { filename: `${data.contract.number}-source.pdf`, inline: !download });
  } catch {
    return NextResponse.json({ error: "integrity_check_failed" }, { status: 409 });
  }
}

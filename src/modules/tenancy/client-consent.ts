import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaces } from "@/db/schema";
import { escapeHtml } from "@/lib/html";
import { sendMail } from "@/modules/mail";

/**
 * ایمیل «تأیید عضویت به‌عنوان مشتری» برای صاحب حسابی که از قبل در سامانه هست (SEC-06).
 * هیچ اطلاعاتی از فضای کاری درخواست‌دهنده جز نام عمومی آن فاش نمی‌شود و برعکس؛ عضویت فقط با ورود و پذیرش خودِ او ثبت می‌شود.
 */
export async function sendClientConsentEmail(p: { workspaceId: number; email: string; token: string; base: string }): Promise<void> {
  const base = p.base.replace(/\/+$/, "");
  if (!base) {
    console.error("[security] ایمیل تأیید مشتری ارسال نشد: آدرس مورد اعتماد سایت (APP_URL) تنظیم نشده است.");
    return;
  }
  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, p.workspaceId));
  const link = `${base}/invite/${p.token}`;
  await sendMail({
    to: p.email,
    subject: `درخواست افزودن شما به «${ws?.name ?? "یک کسب‌وکار"}»`,
    html: `<div dir="rtl"><p>کسب‌وکار «${escapeHtml(ws?.name ?? "")}» می‌خواهد شما را به‌عنوان مشتری به فهرست خود اضافه کند و برایتان قرارداد صادر کند.</p><p>برای حفظ حریم خصوصی شما، تا زمانی که این درخواست را نپذیرید هیچ‌یک از اطلاعات حسابتان برای آن‌ها قابل مشاهده نیست. اگر با این کسب‌وکار آشنا هستید وارد شوید و بپذیرید:</p><p><a href="${link}">${link}</a></p><p>این درخواست ۷ روز معتبر است. اگر آشنا نیستید، این ایمیل را نادیده بگیرید.</p></div>`,
    workspaceId: p.workspaceId,
  });
}

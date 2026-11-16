"use server";

import { rateLimit } from "@/lib/rate-limit";
import { getOrigin } from "@/lib/request";
import { logAudit } from "@/modules/audit/service";
import { requireTeam } from "@/modules/tenancy/context";
import { EMAIL_RE } from "@/modules/tenancy/service";
import { getReferralConfig, sendInviteEmails } from "./service";

export type InviteState = { error?: string; ok?: boolean; message?: string };

/** ارسال ایمیل دعوت (حداکثر ۵ ایمیل در هر درخواست؛ سقف ساعتی برای جلوگیری از اسپم) */
export async function inviteByEmailAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const team = await requireTeam("view");
  const cfg = await getReferralConfig();
  if (!cfg.enabled) return { error: "برنامه‌ی دعوت از دوستان فعلاً غیرفعال است" };
  const emails = [...new Set(String(formData.get("emails") || "").split(/[\s,;،]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0) return { error: "حداقل یک ایمیل وارد کنید" };
  if (emails.length > 5) return { error: "در هر بار حداکثر ۵ ایمیل مجاز است" };
  if (emails.some((e) => !EMAIL_RE.test(e) || e.length > 120)) return { error: "یکی از ایمیل‌ها معتبر نیست" };
  if (emails.includes(team.email.toLowerCase())) return { error: "ایمیل خودتان را نمی‌توانید دعوت کنید" };
  if (!rateLimit(`ref:invite:${team.id}`, 15, 60 * 60_000).ok) return { error: "تعداد دعوت‌ها زیاد بود؛ بعداً تلاش کنید." };
  const { sent } = await sendInviteEmails({ from: { id: team.id, name: team.name }, emails, origin: await getOrigin() });
  await logAudit({ action: "referral.invited", workspaceId: team.workspaceId, userId: team.id, detail: `${emails.length} ایمیل` });
  return { ok: true, message: sent > 0 ? `${sent.toLocaleString("fa-IR")} دعوت‌نامه ارسال شد.` : "دعوت‌نامه ثبت شد (سرویس ایمیل تنظیم نشده؛ لینک دعوت را مستقیم برای دوستانتان بفرستید)." };
}

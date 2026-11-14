import nodemailer from "nodemailer";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { getAllSettings } from "@/modules/settings/service";
import { workspaceOfContract } from "@/modules/tenancy/service";
import { guardedSmtpOptions } from "@/lib/smtp-guard";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export async function sendMail(opts: { to: string; subject: string; html: string; contractId?: number | null; workspaceId?: number; attachments?: MailAttachment[] }) {
  const workspaceId = opts.workspaceId ?? (await workspaceOfContract(opts.contractId));
  const cfg = await getAllSettings(workspaceId);
  // ایمیل‌های سطح پلتفرم (تیکت‌ها و …) از SMTP_* در محیط سرور ارسال می‌شود
  // فضای کاری بدون SMTP اختصاصی هم از SMTP پلتفرم استفاده می‌کند تا ایمیل‌ها بدون هیچ تنظیمی ارسال شوند
  let platformSmtp = false; // M-01: فقط SMTP پلتفرم (env سرور) مورد اعتماد است؛ SMTP فضای کاری همیشه از محافظ می‌گذرد
  if ((!workspaceId || !cfg.smtp_host) && process.env.SMTP_HOST) {
    platformSmtp = true;
    cfg.smtp_host = process.env.SMTP_HOST;
    cfg.smtp_port = process.env.SMTP_PORT || "587";
    cfg.smtp_user = process.env.SMTP_USER || "";
    cfg.smtp_pass = process.env.SMTP_PASS || "";
    cfg.smtp_from = process.env.SMTP_FROM || "";
  }
  let status: "sent" | "logged" | "failed" = "logged";
  let error: string | null = null;

  if (cfg.smtp_host) {
    try {
      // M-01: پورت فهرست‌سفید + resolve/pin در همین لحظه (ضد SSRF، اسکن پورت و DNS Rebinding)
      const target = await guardedSmtpOptions(cfg.smtp_host, cfg.smtp_port, { trusted: platformSmtp });
      const transport = nodemailer.createTransport({
        host: target.host,
        port: target.port,
        secure: target.secure,
        tls: target.tls,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
        auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass } : undefined,
      });
      await transport.sendMail({
        from: cfg.smtp_from || cfg.smtp_user || cfg.admin_email,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        attachments: opts.attachments,
      });
      status = "sent";
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message : "خطای ارسال ایمیل";
    }
  }

  await db.insert(notifications).values({
    channel: "email",
    recipient: opts.to,
    subject: opts.subject,
    body: opts.attachments?.length ? `${opts.html}\n<!-- پیوست: ${opts.attachments.map((a) => a.filename).join("، ")} -->` : opts.html,
    status,
    error,
    contractId: opts.contractId ?? null,
    workspaceId,
  });
  return { status, error };
}

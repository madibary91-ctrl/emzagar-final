import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts } from "@/db/schema";
import { escapeHtml } from "@/lib/html";
import { fa } from "@/lib/jalali";
import { kycDir, signaturesDir } from "@/lib/storage-paths";
import { logAudit } from "@/modules/audit/service";
import { currentSigner, getSigners } from "@/modules/contracts/service";
import { notifyTeam, notifyUser, notifyUsers } from "@/modules/inbox/service";
import { sendMail } from "@/modules/mail";
import { generateContractPdf, type StoredPdf } from "@/modules/pdf/service";
import { getAllSettings } from "@/modules/settings/service";
import { notifySigner } from "@/modules/signing/links";
import { enqueueJob, registerJobHandler } from "./queue";

/* ───────────────────────────── PERF-03: کارهای پس از امضا ───────────────────────────── */

/** اعلان‌های درون‌برنامه‌ای + نوبت امضاکننده‌ی بعدی. هر گام مستقل است و خطای آن کل کار را (و در نتیجه اعلان‌های تکراری) تکرار نمی‌کند. */
async function step(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error(`[job:sign.notify:${label}]`, e);
  }
}

registerJobHandler("sign.notify", {
  async run(p) {
    const contractId = Number(p.contractId);
    const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId));
    if (!contract) return;
    const signerLabel = String(p.signerLabel ?? "");
    const userName = String(p.userName ?? "");
    const signers = await getSigners(contractId);
    await step("notify-team", () =>
      notifyTeam(contract.workspaceId, { kind: "info", title: `${signerLabel} قرارداد ${contract.number} را امضا کرد`, body: `${userName} — ${contract.title}`, href: `/contracts/${contractId}` }, [contract.createdBy]),
    );
    if (p.completed) {
      await step("notify-final", async () => {
        await notifyUsers(signers.map((s) => s.userId), { kind: "success", title: `قرارداد ${contract.number} نهایی شد`, body: `«${contract.title}» توسط همه‌ی طرفین امضا شد.`, href: `/contracts/${contractId}` });
        await notifyTeam(
          contract.workspaceId,
          { kind: "success", title: `قرارداد ${contract.number} نهایی شد`, body: `«${contract.title}» توسط همه‌ی طرفین امضا شد${contract.termEndsAt ? ` — پایان مدت: ${fa(contract.termEndsAt)}` : ""}.`, href: `/contracts/${contractId}` },
          [contract.createdBy],
        );
      });
    } else {
      const next = currentSigner(signers);
      if (next) {
        await step("notify-signer", () => notifySigner(contractId, next.id, "turn"));
        await step("notify-next", () => notifyUser(next.userId, { kind: "action", title: `نوبت امضای شما: ${contract.number}`, body: `«${contract.title}» منتظر امضای شماست.`, href: `/contracts/${contractId}` }));
      }
    }
  },
});

/** تولید PDF نهایی + هش (ایدمپوتنت). شکست = تلاش دوباره؛ پس از آخرین شکست در ممیزی ثبت می‌شود. موفقیت = صف‌کردن ایمیل هر گیرنده. */
registerJobHandler("contract.finalize", {
  async run(p) {
    const contractId = Number(p.contractId);
    await generateContractPdf(contractId);
    const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId));
    if (!contract) return;
    const cfg = await getAllSettings(contract.workspaceId);
    const signers = await getSigners(contractId);
    const recipients = new Set([cfg.admin_email, ...signers.map((s) => s.userEmail)].filter((e) => e && !e.endsWith(".invalid")));
    for (const to of recipients) {
      // kick:false — همین حلقه‌ی پردازش، کار تازه را برمی‌دارد (از بن‌بست در حالت inline جلوگیری می‌کند)
      await enqueueJob("contract.mail_final", { contractId, to }, { dedupeKey: `mail-final:${contractId}:${to}`, kick: false });
    }
  },
  async onDead(p, error) {
    const contractId = Number(p.contractId);
    await logAudit({ action: "document.failed", contractId, detail: error.slice(0, 200) || "خطای ناشناخته", actor: "system" });
  },
});

/** ایمیل نسخه‌ی نهایی (PDF پیوست + هش) به یک گیرنده؛ شکست SMTP = تلاش دوباره (فقط همین گیرنده) */
registerJobHandler("contract.mail_final", {
  async run(p, ctx) {
    const contractId = Number(p.contractId);
    const to = String(p.to ?? "");
    const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId));
    if (!contract || !to) return;
    let pdf: StoredPdf | null = null;
    try {
      pdf = await generateContractPdf(contractId);
    } catch (e) {
      // تا آخرین تلاش منتظر PDF می‌مانیم؛ در آخرین تلاش، ایمیل بدون پیوست (با راهنمای دریافت از پنل) فرستاده می‌شود
      if (!ctx.last) throw e;
    }
    const cfg = await getAllSettings(contract.workspaceId);
    const base = (cfg.app_url || "").replace(/\/+$/, "");
    const verify = base && contract.docHash ? `${base}/verify/${contract.docHash}` : "";
    const res = await sendMail({
      to,
      subject: `قرارداد ${contract.number} امضا شد`,
      html: `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:2"><p>قرارداد «${escapeHtml(contract.title)}» توسط همه‌ی طرفین امضا شد.</p>${
        pdf ? `<p>نسخه‌ی PDF رسمی سند پیوست این ایمیل است.</p><p style="font-size:12px;color:#555">SHA-256 فایل PDF:<br/><span dir="ltr" style="font-family:monospace;word-break:break-all">${pdf.sha256}</span></p>` : "<p>نسخه‌ی PDF را از پنل می‌توانید دریافت کنید.</p>"
      }${verify ? `<p>استعلام اصالت سند: <a href="${verify}">${verify}</a></p>` : ""}</div>`,
      contractId,
      attachments: pdf ? [{ filename: `${contract.number}.pdf`, content: pdf.buffer, contentType: "application/pdf" }] : undefined,
    });
    if (res.status === "failed") throw new Error(res.error || "ارسال ایمیل ناموفق بود");
  },
});

/* ───────────────────────────── DB-04: پاک‌سازی فایل‌های حساب حذف‌شده ───────────────────────────── */

const base = (n: string) => path.basename(n);

/** حذف فایل‌های ذخیره‌شده (امضا/مدارک KYC) پس از commit ناشناس‌سازی؛ ماندگار و تکرارپذیر (نبودن فایل = موفقیت) */
registerJobHandler("files.purge", {
  async run(p) {
    const unlink = async (dir: string, names: unknown) => {
      for (const n of Array.isArray(names) ? names : []) {
        try {
          await fs.unlink(path.join(dir, base(String(n))));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
    };
    await unlink(signaturesDir(), p.signatures);
    await unlink(kycDir(), p.kyc);
  },
});

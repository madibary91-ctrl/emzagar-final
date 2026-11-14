import { type CheckDef, type Metric, type Step } from "../types";
import { ageText, fa } from "./util";
import { backupOverview, verifyLatestBackup } from "@/modules/backup/service";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export const scheduler: CheckDef = {
  id: "scheduler",
  group: "core",
  label: "زمان‌بند و کرون",
  weight: 2,
  fixHref: "/admin/automation",
  fixLabel: "یادآوری و انقضا",
  async run() {
    const g = globalThis as typeof globalThis & { __amzScheduler?: NodeJS.Timeout };
    const interval = Math.max(1, Number(process.env.CRON_INTERVAL_MINUTES) || 10);
    const last = (await db.execute(sql`select trigger, error, created_at from cron_runs order by id desc limit 1`)).rows[0] as { trigger: string; error: string | null; created_at: Date } | undefined;
    const running = !!g.__amzScheduler;
    const metrics: Metric[] = [
      { label: "زمان‌بند داخلی", value: running ? `فعال (هر ${fa(interval)} دقیقه)` : "غیرفعال", tone: running ? "ok" : "warn" },
    ];
    if (last) {
      const age = Date.now() - new Date(last.created_at).getTime();
      metrics.push({ label: "آخرین اجرا", value: `${ageText(age)} پیش (${last.trigger})`, tone: age > interval * 60_000 * 4 ? "warn" : "ok" });
      if (last.error) metrics.push({ label: "خطای آخرین اجرا", value: last.error.slice(0, 120), tone: "fail" });
    } else metrics.push({ label: "آخرین اجرا", value: "هنوز اجرا نشده" });
    const age = last ? Date.now() - new Date(last.created_at).getTime() : Infinity;
    const stale = age > Math.max(interval * 60_000 * 4, 3600_000);
    if (last?.error) return { status: "warn", summary: "آخرین اجرای زمان‌بند خطا داشت", metrics, hints: ["لاگ سرور را برای جزئیات بررسی کنید."] };
    if (!running && stale) return { status: "fail", summary: "زمان‌بند فعال نیست و اجرای اخیری ثبت نشده", metrics, hints: ["اگر هاست پردازه‌ی دائمی ندارد، /api/cron/run را با کرون هاست (با CRON_SECRET) فراخوانی کنید."] };
    if (stale && last) return { status: "warn", summary: `${ageText(age)} است اجرایی ثبت نشده`, metrics };
    return { status: running || last ? "ok" : "warn", summary: last ? `آخرین اجرا ${ageText(age)} پیش` : "زمان‌بند فعال؛ هنوز اجرایی ثبت نشده", metrics };
  },
};
export const backup: CheckDef = {
  id: "backup",
  group: "core",
  label: "بک‌آپ خودکار",
  weight: 2,
  deepAvailable: true,
  deepLabel: "راستی‌آزمایی آخرین بک‌آپ",
  fixHref: "/platform",
  async run(_ctx, deep) {
    const ov = await backupOverview();
    const metrics: Metric[] = [
      { label: "بک‌آپ خودکار", value: ov.cfg.enabled ? `روشن (هر ${fa(ov.cfg.intervalHours)} ساعت، نگهداری ${fa(ov.cfg.keep)} نسخه)` : "خاموش", tone: ov.cfg.enabled ? "ok" : "warn" },
      { label: "مقصد", value: ov.cfg.dir },
      { label: "تعداد نسخه‌ها", value: fa(ov.list.length) },
    ];
    const steps: Step[] = [];
    if (deep) {
      const t0 = performance.now();
      const v = await verifyLatestBackup();
      steps.push({ name: "راستی‌آزمایی", ok: !!v && (v as { ok?: boolean }).ok !== false, ms: Math.round(performance.now() - t0), detail: v ? `${v.name}: ${JSON.stringify(v).slice(0, 120)}` : "بک‌آپی برای بررسی نیست" });
    }
    if (!ov.cfg.enabled) return { status: "warn", summary: "بک‌آپ خودکار خاموش است", metrics, steps, hints: ["BACKUP_ENABLED=0 را بردارید؛ پیش از لانچ بک‌آپ منظم ضروری است."] };
    const lastOk = ov.list.find((b) => b.ok);
    if (!lastOk && !ov.last) return { status: "warn", summary: "هنوز بک‌آپی گرفته نشده", metrics, steps, hints: ["اولین بک‌آپ طی ۴۵ ثانیه تا چند دقیقه پس از بالا آمدن سرور گرفته می‌شود."] };
    if (ov.last && !ov.last.ok) return { status: "fail", summary: `آخرین بک‌آپ ناموفق بود: ${(ov.last.error || "").slice(0, 100)}`, metrics, steps };
    const at = new Date(ov.last?.at ?? 0).getTime() || (lastOk ? new Date(lastOk.createdAt).getTime() : 0);
    if (at) {
      const age = Date.now() - at;
      metrics.push({ label: "آخرین بک‌آپ موفق", value: `${ageText(age)} پیش`, tone: age > ov.cfg.intervalHours * 3600_000 * 2.5 ? "warn" : "ok" });
      if (age > ov.cfg.intervalHours * 3600_000 * 2.5) return { status: "warn", summary: `آخرین بک‌آپ ${ageText(age)} پیش بوده`, metrics, steps };
      return { status: "ok", summary: `آخرین بک‌آپ ${ageText(age)} پیش`, metrics, steps };
    }
    return { status: "ok", summary: "بک‌آپ‌ها موجودند", metrics, steps };
  },
};

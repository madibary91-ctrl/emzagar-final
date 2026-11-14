import type { Metadata } from "next";
import Shell from "@/components/Shell";
import HealthDashboard from "@/components/HealthDashboard";
import { requirePlatformAdmin } from "@/modules/platform/admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "سلامت سیستم" };

/** داشبورد سلامت سیستم: وضعیت لحظه‌ای همه‌ی سرویس‌های داخلی و بیرونی + ابزارهای عیب‌یابی (فقط مدیر کل) */
export default async function HealthPage() {
  const admin = await requirePlatformAdmin();
  return (
    <Shell user={admin} wide>
      <h1 className="mb-1 text-2xl font-black">سلامت سیستم</h1>
      <p className="mb-5 text-xs text-ink/72">وضعیت زنده‌ی دیتابیس، ایمیل، پیامک، درگاه‌های پرداخت، هوش مصنوعی و سرور لایسنس — با ابزار تست و عیب‌یابی هر سرویس و امتیاز آمادگی لانچ.</p>
      <HealthDashboard />
    </Shell>
  );
}

import type { Metadata } from "next";
import { headers } from "next/headers";
import InstallWizard from "@/components/InstallWizard";
import { getInstallStatus } from "@/modules/install/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "نصب امضاگیر", robots: { index: false, follow: false } };

export default async function InstallPage() {
  const h = await headers();
  const https = (h.get("x-forwarded-proto") || "").split(",")[0].trim() === "https";
  const status = await getInstallStatus(https);
  // ریدایرکت نمی‌کنیم: پس از ساخت حساب، رندر دوباره‌ی سرور نباید مرحله‌ی «پایان» را از کاربر بگیرد
  return <InstallWizard status={status} />;
}

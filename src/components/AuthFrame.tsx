import type { ReactNode } from "react";
import { Brand } from "@/components/Brand";
import { getBranding } from "@/modules/branding/service";

/** قاب مشترک صفحه‌های احراز هویت (ثبت‌نام، بازیابی رمز، دعوت) */
export default async function AuthFrame({ title, subtitle, children, workspaceId = 0 }: { title: string; subtitle?: string; children: ReactNode; workspaceId?: number }) {
  const brand = await getBranding(workspaceId);
  return (
    <main className="grid min-h-screen place-items-center bg-paper px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-7 flex justify-center"><Brand name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></div>
        <div className="panel-solid p-6 sm:p-9">
          <h1 className="text-2xl font-black">{title}</h1>
          {subtitle && <p className="mt-2 text-xs leading-7 text-ink/75">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </main>
  );
}

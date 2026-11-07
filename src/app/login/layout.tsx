import type { Metadata } from "next";
import type { ReactNode } from "react";

/** بخش خصوصی/عملیاتی: نباید در موتورهای جست‌وجو ایندکس شود */
export const metadata: Metadata = { robots: { index: false, follow: false, nocache: true } };

export default function PrivateLayout({ children }: { children: ReactNode }) {
  return children;
}

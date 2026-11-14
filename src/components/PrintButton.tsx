"use client";

import { useEffect } from "react";

export default function PrintButton({ auto }: { auto?: boolean }) {
  useEffect(() => {
    if (auto) {
      const t = setTimeout(() => window.print(), 600);
      return () => clearTimeout(t);
    }
  }, [auto]);
  return (
    <button onClick={() => window.print()} className="btn btn-primary no-print">
      دانلود PDF / چاپ
    </button>
  );
}

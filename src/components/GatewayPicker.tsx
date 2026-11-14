"use client";

import { useState } from "react";
import { AlertTriangle, Landmark } from "lucide-react";
import type { CheckoutGateway } from "@/modules/payments/registry";

/** انتخاب درگاه پرداخت؛ درگاه ناپایدار علامت می‌خورد (و در صورت قطعی، سیستم خودکار درگاه دیگری را امتحان می‌کند) */
export default function GatewayPicker({ gateways }: { gateways: CheckoutGateway[] }) {
  const first = gateways.find((g) => !g.degraded) ?? gateways[0];
  const [sel, setSel] = useState(first?.id ?? "");
  if (gateways.length === 0) return null;
  return (
    <fieldset className="mb-5">
      <legend className="mb-2 flex items-center gap-1.5 text-xs font-bold text-ink/75"><Landmark size={14} />درگاه پرداخت</legend>
      <input type="hidden" name="gateway" value={sel} />
      <div role="radiogroup" aria-label="درگاه پرداخت" className="flex flex-wrap gap-2">
        {gateways.map((g) => (
          <button
            key={g.id}
            type="button"
            role="radio"
            aria-checked={sel === g.id}
            onClick={() => setSel(g.id)}
            title={g.blurb}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-4 py-2 text-xs font-bold transition ${sel === g.id ? "border-ink bg-ink text-white" : "border-ink/12 bg-white text-ink/80 hover:border-ink/30"}`}
          >
            {g.label}
            {g.degraded && <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-500"><AlertTriangle size={11} />ناپایدار</span>}
          </button>
        ))}
      </div>
      {gateways.length > 1 && <p className="mt-2 text-xs text-ink/70">اگر درگاه انتخابی پاسخ ندهد، به‌طور خودکار درگاه جایگزین امتحان می‌شود.</p>}
    </fieldset>
  );
}

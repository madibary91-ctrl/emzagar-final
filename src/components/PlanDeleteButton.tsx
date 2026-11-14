"use client";

import { Trash2 } from "lucide-react";
import { deletePlanAction } from "@/modules/billing/plan-actions";

/** حذف طرح با تأیید؛ اگر طرح سابقه‌ی اشتراک/پرداخت داشته باشد سرور آن را بایگانی می‌کند (متن تأیید همین را می‌گوید) */
export default function PlanDeleteButton({ id, name, hasHistory }: { id: string; name: string; hasHistory: boolean }) {
  return (
    <form
      action={deletePlanAction}
      onSubmit={(e) => {
        const msg = hasHistory
          ? `طرح «${name}» سابقه‌ی اشتراک یا پرداخت دارد و حذف کامل نمی‌شود؛ بایگانی می‌شود (دیگر فروخته نمی‌شود ولی مشترکان فعلی تا پایان دوره‌شان آن را دارند). ادامه می‌دهید؟`
          : `طرح «${name}» برای همیشه حذف شود؟`;
        if (!confirm(msg)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button className="btn-danger btn-sm"><Trash2 size={13} />{hasHistory ? "حذف (بایگانی)" : "حذف طرح"}</button>
    </form>
  );
}

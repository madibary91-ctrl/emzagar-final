"use client";

import { Trash2 } from "lucide-react";
import ConfirmButton from "@/components/ConfirmButton";
import { deletePlanAction } from "@/modules/billing/plan-actions";

/** حذف طرح با تأیید؛ اگر طرح سابقه‌ی اشتراک/پرداخت داشته باشد سرور آن را بایگانی می‌کند (متن تأیید همین را می‌گوید) */
export default function PlanDeleteButton({ id, name, hasHistory }: { id: string; name: string; hasHistory: boolean }) {
  const msg = hasHistory
    ? `طرح «${name}» سابقه‌ی اشتراک یا پرداخت دارد و حذف کامل نمی‌شود؛ بایگانی می‌شود (دیگر فروخته نمی‌شود ولی مشترکان فعلی تا پایان دوره‌شان آن را دارند). ادامه می‌دهید؟`
    : `طرح «${name}» برای همیشه حذف شود؟`;
  return (
    <form action={deletePlanAction}>
      <input type="hidden" name="id" value={id} />
      <ConfirmButton className="btn-danger btn-sm" message={msg} title={hasHistory ? "بایگانی طرح" : "حذف طرح"} confirmLabel={hasHistory ? "بله، بایگانی شود" : "بله، حذف شود"}>
        <Trash2 size={13} />{hasHistory ? "حذف (بایگانی)" : "حذف طرح"}
      </ConfirmButton>
    </form>
  );
}

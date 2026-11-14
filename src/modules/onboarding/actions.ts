"use server";

import { getCurrentUser } from "@/modules/auth/session";
import { deletePref, setPref } from "@/modules/prefs/service";

import { TOUR_PREF } from "./constants";

/** ثبت پایان/بستن راهنما برای کاربر جاری؛ پس از آن راهنما دیگر خودکار باز نمی‌شود */
export async function setTourStateAction(state: "completed" | "dismissed"): Promise<void> {
  const user = await getCurrentUser();
  if (!user) return;
  await setPref(user.id, TOUR_PREF, state === "completed" ? "completed" : "dismissed");
}

/** بازنشانی: راهنما دوباره قابل اجراست (و در ورود بعدی هم خودکار باز می‌شود) */
export async function resetTourAction(): Promise<void> {
  const user = await getCurrentUser();
  if (!user) return;
  await deletePref(user.id, TOUR_PREF);
}

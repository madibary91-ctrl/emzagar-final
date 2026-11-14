"use server";

import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { cancelBatch, deleteBatch, MergeError, previewBatch, retryFailed, startBatch, type PreviewResult } from "./service";
import type { MergeMapping, MergeOptions } from "./pure";

export type MergeResult = { ok: boolean; error?: string; message?: string };
type Cfg = { mapping: MergeMapping; options: Partial<MergeOptions> };

const err = (e: unknown, fallback: string): MergeResult => ({ ok: false, error: e instanceof MergeError ? e.message : fallback });

export async function previewMergeAction(batchId: number, cfg: Cfg, sampleRowNo?: number): Promise<{ ok: true; preview: PreviewResult } | { ok: false; error: string }> {
  const team = await requireTeam("write");
  try {
    return { ok: true, preview: await previewBatch(team, Number(batchId), cfg, sampleRowNo ? Number(sampleRowNo) : undefined) };
  } catch (e) {
    return { ok: false, error: e instanceof MergeError ? e.message : "پیش‌نمایش ساخته نشد" };
  }
}

export async function startMergeAction(batchId: number, cfg: Cfg): Promise<MergeResult> {
  const team = await requireTeam("write");
  try {
    const r = await startBatch(team, Number(batchId), cfg);
    revalidatePath("/admin/merge");
    return { ok: true, message: `${r.queued.toLocaleString("fa-IR")} قرارداد در صف ارسال قرار گرفت` };
  } catch (e) {
    return err(e, "شروع ارسال انجام نشد");
  }
}

export async function cancelMergeAction(batchId: number): Promise<MergeResult> {
  const team = await requireTeam("write");
  try {
    const n = await cancelBatch(team, Number(batchId));
    revalidatePath(`/admin/merge/${batchId}`);
    return { ok: true, message: `${n.toLocaleString("fa-IR")} ردیف ارسال نشد` };
  } catch (e) {
    return err(e, "لغو انجام نشد");
  }
}

export async function retryMergeAction(batchId: number): Promise<MergeResult> {
  const team = await requireTeam("write");
  try {
    const n = await retryFailed(team, Number(batchId));
    revalidatePath(`/admin/merge/${batchId}`);
    return { ok: true, message: `${n.toLocaleString("fa-IR")} ردیف دوباره در صف قرار گرفت` };
  } catch (e) {
    return err(e, "تلاش دوباره انجام نشد");
  }
}

export async function deleteMergeAction(batchId: number): Promise<MergeResult> {
  const team = await requireTeam("delete");
  try {
    await deleteBatch(team, Number(batchId));
    revalidatePath("/admin/merge");
    return { ok: true };
  } catch (e) {
    return err(e, "حذف انجام نشد");
  }
}

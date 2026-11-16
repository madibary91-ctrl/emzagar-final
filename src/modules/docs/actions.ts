"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { issueContract } from "@/modules/contracts/service";
import { ensureGuestSigner, GuestError } from "@/modules/guests/service";
import { attachSourceToContract, DocError, getUsableDraft, sourceStubHtml } from "./service";
import { sanitizePlacements } from "./placement";

export type IssueFileState = { error?: string };

export interface FileParty {
  label: string;
  /** شناسه‌ی کاربر موجود (عضو/مشتری فضای کاری) یا null برای مهمان جدید */
  userId: number | null;
  guestName?: string;
  guestMobile?: string;
}

/** صدور قرارداد از روی فایل PDF/Word بارگذاری‌شده، با جانمایی بصری (امضاکنندگان به ترتیب) */
export async function issueFromFileAction(input: { title: string; draftCode: string; placements: unknown; parties: FileParty[]; expiryDays?: number | null }): Promise<IssueFileState> {
  const admin = await requireTeam("write");
  const title = String(input?.title ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  if (title.length < 3) return { error: "عنوان قرارداد را وارد کنید" };
  const parties = Array.isArray(input?.parties) ? input.parties.slice(0, 6) : [];
  if (parties.length === 0) return { error: "حداقل یک امضاکننده لازم است" };

  let draft;
  try {
    draft = await getUsableDraft(String(input.draftCode || ""), admin.workspaceId);
  } catch (e) {
    return { error: e instanceof DocError ? e.message : "فایل معتبر نیست" };
  }
  const pl = sanitizePlacements(input.placements, draft.pageCount, parties.length, { requireSignatureFor: parties.map((_, i) => i + 1) });
  if (!pl.ok) return { error: pl.error };

  const resolved: { label: string; userId: number }[] = [];
  try {
    for (let i = 0; i < parties.length; i++) {
      const p = parties[i];
      const label = String(p.label || "").trim().slice(0, 60) || (i === parties.length - 1 ? "مشتری" : `امضاکننده ${i + 1}`);
      if (p.userId) resolved.push({ label, userId: Number(p.userId) });
      else {
        const g = await ensureGuestSigner(admin.workspaceId, { name: String(p.guestName ?? ""), mobile: String(p.guestMobile ?? "") });
        resolved.push({ label, userId: g.userId });
      }
    }
  } catch (e) {
    return { error: e instanceof GuestError ? e.message : "ثبت امضاکننده انجام نشد" };
  }

  const last = resolved[resolved.length - 1];
  let id = 0;
  try {
    id = await issueContract({
      workspaceId: admin.workspaceId,
      title,
      bodyHtml: sourceStubHtml(draft.originalName, draft.originalSha256),
      customerId: last.userId,
      customerLabel: last.label,
      extraSigners: resolved.slice(0, -1),
      createdBy: admin.id,
      expiryDays: input.expiryDays === undefined || input.expiryDays === null ? undefined : Math.max(0, Math.min(3650, Number(input.expiryDays) || 0)),
      onCreated: (cid) => attachSourceToContract(cid, draft, pl.items),
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "خطا در صدور قرارداد" };
  }
  revalidatePath("/admin");
  redirect(`/contracts/${id}`);
}

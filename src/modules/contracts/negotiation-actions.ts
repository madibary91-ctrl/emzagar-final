"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/modules/auth/session";
import { getTeamContext } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { rateLimit } from "@/lib/rate-limit";
import { getRequestInfo } from "@/lib/request";
import { resolveSigningToken } from "@/modules/signing/links";
import { getContractForUser } from "./service";
import { addComment, setCommentResolved, type CommentKind, type CommentVisibility } from "./negotiation";

export type CommentResult = { ok: boolean; error?: string };

export interface CommentPayload {
  body: string;
  visibility?: CommentVisibility;
  kind?: CommentKind;
  quote?: string;
  parentId?: number | null;
}

/** ارسال پیام از حساب کاربری: تیم (داخلی/مشترک) یا امضاکننده‌ی واردشده (همیشه مشترک) */
export async function postCommentAction(contractId: number, payload: CommentPayload): Promise<CommentResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "ابتدا وارد حساب خود شوید" };
  const id = Number(contractId);
  const data = await getContractForUser(user, id);
  if (!data) return { ok: false, error: "قرارداد یافت نشد" };
  if (!rateLimit(`comment:user:${user.id}`, 30, 10 * 60_000).ok) return { ok: false, error: "پیام‌های زیادی فرستاده‌اید؛ کمی بعد دوباره تلاش کنید" };

  const team = data.teamRole ? await getTeamContext() : null;
  const isTeam = !!team && team.workspaceId === data.contract.workspaceId && can(data.teamRole, "write");
  const isParty = !data.teamRole && (data.contract.customerId === user.id || data.signers.some((s) => s.userId === user.id));
  if (!isTeam && !isParty) return { ok: false, error: "شما اجازه‌ی ارسال پیام ندارید" };
  if (isParty && !["sent", "signed"].includes(data.contract.status)) return { ok: false, error: "این قرارداد دیگر پیام جدید نمی‌پذیرد" };

  const res = await addComment({
    contractId: id,
    authorUserId: user.id,
    authorName: user.name,
    side: isTeam ? "team" : "signer",
    visibility: payload.visibility === "internal" ? "internal" : "shared",
    kind: payload.kind === "change_request" ? "change_request" : "comment",
    body: String(payload.body ?? ""),
    quote: String(payload.quote ?? ""),
    parentId: payload.parentId ? Number(payload.parentId) : null,
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath(`/contracts/${id}`);
  return { ok: true };
}

/** ارسال پیام از صفحه‌ی امضای بدون ثبت‌نام (فقط با لینک اختصاصیِ معتبر) */
export async function guestPostCommentAction(token: string, payload: CommentPayload): Promise<CommentResult> {
  const st = await resolveSigningToken(String(token || ""));
  if (st.status !== "ok") return { ok: false, error: "این لینک دیگر معتبر نیست" };
  const { link, signer, contract, user } = st.ctx;
  const { ip } = await getRequestInfo();
  if (!rateLimit(`gcomment:link:${link.id}`, 12, 10 * 60_000).ok || !rateLimit(`gcomment:ip:${ip}`, 40, 10 * 60_000).ok) {
    return { ok: false, error: "پیام‌های زیادی فرستاده‌اید؛ کمی بعد دوباره تلاش کنید" };
  }
  const res = await addComment({
    contractId: contract.id,
    authorUserId: user.id,
    authorName: `${user.name} (${signer.label})`,
    side: "signer",
    visibility: "shared",
    kind: payload.kind === "change_request" ? "change_request" : "comment",
    body: String(payload.body ?? ""),
    quote: String(payload.quote ?? ""),
    parentId: payload.parentId ? Number(payload.parentId) : null,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

/** بستن یا بازکردن مجدد یک موضوع مذاکره (فقط تیم با دسترسی نوشتن) */
export async function resolveCommentAction(contractId: number, commentId: number, resolved: boolean): Promise<CommentResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "ابتدا وارد حساب خود شوید" };
  const data = await getContractForUser(user, Number(contractId));
  if (!data) return { ok: false, error: "قرارداد یافت نشد" };
  const team = data.teamRole ? await getTeamContext() : null;
  if (!team || team.workspaceId !== data.contract.workspaceId || !can(data.teamRole, "write")) return { ok: false, error: "دسترسی ندارید" };
  const ok = await setCommentResolved(data.contract.id, Number(commentId), !!resolved, user.id);
  if (!ok) return { ok: false, error: "پیام یافت نشد" };
  revalidatePath(`/contracts/${data.contract.id}`);
  return { ok: true };
}

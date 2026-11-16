import { CHAT_NAME_MAX, type ChatContextKind, type ChatQueue, type ChatTarget, type ChatWidgetContext, QUEUE_LABELS, cleanChatText } from "../meta";
import { ChatError, type Requester } from "./core";
import { and, eq, ne } from "drizzle-orm";
import { contractSigners, contracts, workspaceMembers, workspaces } from "@/db/schema";
import { db } from "@/db";
import { getPayContext } from "@/modules/contract-pay/service";
import { resolveSigningToken } from "@/modules/signing/links";

/* ═════════════ زمینه‌ی گفتگو (چه کسی، درباره‌ی چه چیزی، با چه تیمی) ═════════════ */

export type ResolvedContext = {
  kind: ChatContextKind;
  queue: ChatQueue;
  target: ChatTarget;
  targets: { id: ChatTarget; label: string }[];
  workspaceId: number;
  contractId: number | null;
  signerId: number | null;
  key: string;
  name: string;
  mobile: string;
  title: string;
  contextLabel: string | null;
};
export async function workspaceName(id: number): Promise<string | null> {
  if (!id) return null;
  const [w] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, id));
  return w?.name ?? null;
}
function build(p: {
  kind: ChatContextKind;
  target: ChatTarget;
  withIssuer: boolean;
  workspaceId: number;
  issuerName: string | null;
  contractId?: number | null;
  signerId?: number | null;
  name: string;
  mobile: string;
  contextLabel: string | null;
}): ResolvedContext {
  const toIssuer = p.withIssuer && p.target === "issuer";
  const queue: ChatQueue = toIssuer ? "workspace" : "platform";
  const targets: ResolvedContext["targets"] = p.withIssuer
    ? [
        { id: "issuer", label: p.issuerName ? `تیم ${p.issuerName}` : QUEUE_LABELS.workspace },
        { id: "platform", label: QUEUE_LABELS.platform },
      ]
    : [{ id: "platform", label: QUEUE_LABELS.platform }];
  return {
    kind: p.kind,
    queue,
    target: toIssuer ? "issuer" : "platform",
    targets,
    workspaceId: p.workspaceId,
    contractId: p.contractId ?? null,
    signerId: p.signerId ?? null,
    key: `${p.kind}:${p.contractId ?? 0}:${p.signerId ?? 0}:${queue}`,
    name: p.name.slice(0, CHAT_NAME_MAX),
    mobile: p.mobile.slice(0, 20),
    title: toIssuer ? (p.issuerName ? `تیم ${p.issuerName}` : QUEUE_LABELS.workspace) : QUEUE_LABELS.platform,
    contextLabel: p.contextLabel,
  };
}
/**
 * ورودی ویجت را به زمینه‌ی «تأییدشده» تبدیل می‌کند. هیچ‌چیز از کلاینت بدون راستی‌آزمایی پذیرفته نمی‌شود:
 *  - sign/pay: توکن/کد باید معتبر باشد (همان لینک اختصاصی امضا/پرداخت)
 *  - panel + قرارداد: کاربر باید امضاکننده یا عضو تیم همان قرارداد باشد
 */
export async function resolveContext(who: Requester | null, input: ChatWidgetContext, nameInput?: string): Promise<ResolvedContext> {
  const want: ChatTarget = input.target === "platform" ? "platform" : "issuer";
  if (input.kind === "panel") {
    if (!who || who.kind !== "user") throw new ChatError("auth", "برای گفتگو وارد حساب خود شوید", 401);
    let contract: typeof contracts.$inferSelect | undefined;
    if (input.contractId && Number.isInteger(input.contractId)) {
      [contract] = await db.select().from(contracts).where(eq(contracts.id, input.contractId));
    }
    if (contract) {
      const [member] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, contract.workspaceId), eq(workspaceMembers.userId, who.userId)));
      const isTeam = !!member && member.role !== "client";
      const [signer] = await db.select({ id: contractSigners.id }).from(contractSigners).where(and(eq(contractSigners.contractId, contract.id), eq(contractSigners.userId, who.userId)));
      if (isTeam || signer) {
        const wsName = await workspaceName(contract.workspaceId);
        return build({
          kind: "panel",
          target: want,
          withIssuer: !isTeam, // اعضای تیم خودشان «صادرکننده»‌اند؛ فقط با پلتفرم گفتگو می‌کنند
          workspaceId: contract.workspaceId,
          issuerName: wsName,
          contractId: contract.id,
          signerId: signer?.id ?? null,
          name: who.name,
          mobile: who.mobile,
          contextLabel: `قرارداد ${contract.number}`,
        });
      }
    }
    // کاربر عادی پنل: فضای کاری فعال او (اگر عضو تیم باشد) فقط برای اطلاع پشتیبان
    const [m] = await db.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(and(eq(workspaceMembers.userId, who.userId), ne(workspaceMembers.role, "client"))).limit(1);
    return build({ kind: "panel", target: "platform", withIssuer: false, workspaceId: m?.workspaceId ?? 0, issuerName: null, name: who.name, mobile: who.mobile, contextLabel: null });
  }

  if (input.kind === "sign") {
    const st = await resolveSigningToken(String(input.ref || ""));
    if (st.status !== "ok" && st.status !== "done") throw new ChatError("invalid_link", "لینک امضا نامعتبر است", 404);
    const { contract, signer, user } = st.ctx;
    return build({
      kind: "sign",
      target: want,
      withIssuer: true,
      workspaceId: contract.workspaceId,
      issuerName: await workspaceName(contract.workspaceId),
      contractId: contract.id,
      signerId: signer.id,
      name: user.name,
      mobile: signer.mobile || user.mobile,
      contextLabel: `قرارداد ${contract.number}`,
    });
  }

  if (input.kind === "pay") {
    const ctx = await getPayContext(String(input.ref || ""));
    if (!ctx) throw new ChatError("invalid_link", "لینک پرداخت نامعتبر است", 404);
    return build({
      kind: "pay",
      target: want,
      withIssuer: true,
      workspaceId: ctx.contract.workspaceId,
      issuerName: await workspaceName(ctx.contract.workspaceId),
      contractId: ctx.contract.id,
      signerId: null,
      name: ctx.payer?.name ?? "",
      mobile: ctx.payer?.mobile ?? "",
      contextLabel: `پرداخت قرارداد ${ctx.contract.number}`,
    });
  }

  if (input.kind === "site") {
    const name = cleanChatText(nameInput, CHAT_NAME_MAX).replace(/\n/g, " ");
    return build({ kind: "site", target: "platform", withIssuer: false, workspaceId: 0, issuerName: null, name, mobile: "", contextLabel: null });
  }
  throw new ChatError("bad_context", "زمینه‌ی گفتگو نامعتبر است");
}

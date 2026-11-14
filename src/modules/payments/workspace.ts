import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";
import { availableGateways, getAdapter, type CheckoutGateway } from "./registry";
import { REAL_GATEWAY_IDS, isRealGateway, type GatewayId, type RealGatewayId } from "./types";

/**
 * مرچنت اختصاصی هر فضای کاری برای «پرداخت قرارداد».
 * اگر فضای کاری درگاه خودش را ثبت کرده باشد، وجه مستقیم به حساب خودش می‌رود (نه پلتفرم)؛
 * وگرنه از درگاه‌های پلتفرم استفاده می‌شود (و در پنل هشدار داده می‌شود).
 * مقدار مرچنت با AES-256-GCM رمزنگاری و در تنظیمات سراسری با کلید `wspay_<ws>_<gateway>` نگه‌داری می‌شود.
 */
const key = (ws: number, gw: string) => `wspay_${ws}_${gw}`;

export async function workspaceCredential(workspaceId: number, gw: GatewayId): Promise<string> {
  if (gw === "sandbox" || !isRealGateway(gw)) return "";
  const a = getAdapter(gw);
  const v = decryptSecret(await getGlobalSetting(key(workspaceId, gw))).trim();
  return v && a?.isValidCredential(v) ? v : "";
}

export async function saveWorkspaceCredential(workspaceId: number, gw: RealGatewayId, value: string): Promise<{ ok: boolean; error?: string }> {
  const a = getAdapter(gw);
  const v = value.trim();
  if (!a) return { ok: false, error: "درگاه نامعتبر است" };
  if (v && !a.isValidCredential(v)) return { ok: false, error: `${a.credentialLabel} معتبر نیست` };
  await saveGlobalSetting(key(workspaceId, gw), v ? encryptSecret(v) : "");
  return { ok: true };
}

export type WorkspaceGatewayInfo = { id: RealGatewayId; label: string; credentialLabel: string; configured: boolean };

export async function workspaceGatewayInfos(workspaceId: number): Promise<WorkspaceGatewayInfo[]> {
  const out: WorkspaceGatewayInfo[] = [];
  for (const id of REAL_GATEWAY_IDS) {
    const a = getAdapter(id)!;
    out.push({ id, label: a.label, credentialLabel: a.credentialLabel, configured: !!(await workspaceCredential(workspaceId, id)) });
  }
  return out;
}

export type ContractGateway = CheckoutGateway & { own: boolean };

/** درگاه‌های قابل‌استفاده برای پرداخت قرارداد این فضای کاری: اول مرچنت خودش، وگرنه درگاه‌های پلتفرم */
export async function contractGateways(workspaceId: number): Promise<ContractGateway[]> {
  const own: ContractGateway[] = [];
  for (const id of REAL_GATEWAY_IDS) {
    if (await workspaceCredential(workspaceId, id)) {
      const a = getAdapter(id)!;
      own.push({ id, label: a.label, blurb: "مستقیم به حساب شما", degraded: false, own: true });
    }
  }
  if (own.length) return own;
  return (await availableGateways()).map((g) => ({ ...g, own: false }));
}

/** ترتیب تلاش (با failover) برای پرداخت قرارداد */
export async function contractCandidateOrder(workspaceId: number, preferred?: string): Promise<GatewayId[]> {
  const list = (await contractGateways(workspaceId)).filter((g) => !g.degraded).concat((await contractGateways(workspaceId)).filter((g) => g.degraded));
  const ids = list.map((g) => g.id);
  if (preferred && ids.includes(preferred as GatewayId)) return [preferred as GatewayId, ...ids.filter((x) => x !== preferred)];
  return ids;
}

/** اعتبارنامه‌ی درگاه برای یک تراکنش قرارداد: مرچنت فضای کاری، وگرنه همان اعتبارنامه‌ی پلتفرم */
export async function contractCredential(workspaceId: number, gw: GatewayId, platform: () => Promise<string>): Promise<string> {
  return (await workspaceCredential(workspaceId, gw)) || platform();
}

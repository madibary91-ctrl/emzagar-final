import { type CheckDef } from "../types";
import { REAL_GATEWAY_IDS } from "@/modules/payments/types";
import { ai, license } from "./ai-license";
import { gatewayCheck, paymentFlow, wallet } from "./payments";
import { kyc, outbox, referral } from "./growth";

export const BIZ_CHECKS: CheckDef[] = [...REAL_GATEWAY_IDS.map(gatewayCheck), paymentFlow, wallet, ai, license, kyc, referral, outbox];

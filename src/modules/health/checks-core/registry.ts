import { type CheckDef } from "../types";
import { backup, scheduler } from "./ops";
import { config, publicUrl } from "./config";
import { database, runtime, storage } from "./system";
import { deliverability, email, sms } from "./messaging";

export const CORE_CHECKS: CheckDef[] = [database, runtime, storage, config, publicUrl, scheduler, backup, email, sms, deliverability];

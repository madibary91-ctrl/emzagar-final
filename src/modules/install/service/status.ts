import { type InstallKeySource, installKeySource, prepareInstallKey } from "./key";
import { db } from "@/db";
import { getConfig, storageWritable } from "@/lib/config";
import { getInstallState } from "./state";
import { sql } from "drizzle-orm";

export type InstallStatus = {
  installed: boolean;
  nodeOk: boolean;
  nodeVersion: string;
  storageOk: boolean;
  databaseFromEnv: boolean;
  databaseConnected: boolean;
  keyRequired: boolean;
  keySource: InstallKeySource;
  /** دیتابیس پیکربندی شده ولی وضعیتش خوانده نشد؛ برای امنیت نصب بسته است */
  stateUnknown: boolean;
  https: boolean;
};
export async function getInstallStatus(https: boolean): Promise<InstallStatus> {
  const state = await getInstallState();
  const installed = state === "installed";
  const cfg = getConfig();
  if (state === "fresh") prepareInstallKey();
  let databaseConnected = false;
  if (cfg.databaseUrl) {
    try {
      await db.execute(sql`select 1`);
      databaseConnected = true;
    } catch {
      databaseConnected = false;
    }
  }
  const major = Number(process.versions.node.split(".")[0]);
  return {
    installed,
    nodeOk: major >= 20,
    nodeVersion: process.versions.node,
    storageOk: storageWritable(),
    databaseFromEnv: cfg.databaseFromEnv,
    databaseConnected,
    keyRequired: installKeySource() !== "open",
    keySource: installKeySource(),
    stateUnknown: state === "unknown",
    https,
  };
}

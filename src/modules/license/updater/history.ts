import { ROLLBACK_DIR } from "./paths";
import fs from "node:fs";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";

interface HistoryItem {
  at: string;
  from: string;
  to: string;
  kind: "update" | "rollback";
}
export async function pushHistory(item: HistoryItem) {
  let list: HistoryItem[] = [];
  try {
    list = JSON.parse((await getGlobalSetting("update_history")) || "[]") as HistoryItem[];
  } catch {
    list = [];
  }
  await saveGlobalSetting("update_history", JSON.stringify([item, ...list].slice(0, 12)));
}
export async function getUpdateHistory(): Promise<HistoryItem[]> {
  try {
    return JSON.parse((await getGlobalSetting("update_history")) || "[]") as HistoryItem[];
  } catch {
    return [];
  }
}
export function rollbackAvailable(): string | null {
  try {
    const dirs = fs.readdirSync(ROLLBACK_DIR).sort();
    return dirs.at(-1) ?? null;
  } catch {
    return null;
  }
}

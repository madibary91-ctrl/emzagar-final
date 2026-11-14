export { updateSupport, getUpdateInfo, checkForUpdate, checkUpdatesIfDue } from "./info";
export type { UpdateSupport, UpdateInfo } from "./info";
export { safeEntryPath } from "./package";
export { getUpdateHistory, rollbackAvailable } from "./history";
export { scheduleRestart, installUpdate, rollbackUpdate } from "./install";
export type { UpdateResult } from "./install";

export { normEmail, isEmail } from "./core";
export { sanitizeFeatures, parseFeatures, saveFeatures } from "./features";
export type { Features } from "./features";
export { DEPTH_LEVELS, computeDepth, depthForWorkspace } from "./depth";
export type { DepthStep, Depth } from "./depth";
export { getPulse } from "./pulse";
export type { AttentionItem } from "./pulse";
export { checkAccess, customerCard, trustProfile, workspaceSlugOf } from "./customers";

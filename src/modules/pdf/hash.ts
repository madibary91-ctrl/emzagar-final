import crypto from "node:crypto";

export const sha256Buf = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

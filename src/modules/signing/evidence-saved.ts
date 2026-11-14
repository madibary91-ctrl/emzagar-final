import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { contractSigners } from "@/db/schema";
import { inspectPng } from "@/lib/png";
import { readSignatureFile } from "./storage";

/**
 * آخرین مهر و پاراف «همین کاربر» از امضاهای قبلی‌اش (فقط برای مسیر حساب کاربری وارد‌شده).
 * شرکتی که چند قرارداد امضا می‌کند، هر بار مهر را دوباره بارگذاری نمی‌کند. فقط تصویرِ سالم برمی‌گردد.
 */
export async function getSavedEvidence(userId: number): Promise<{ seal: string | null; initials: string | null }> {
  const load = async (col: "sealFile" | "initialsFile"): Promise<string | null> => {
    const column = col === "sealFile" ? contractSigners.sealFile : contractSigners.initialsFile;
    const [row] = await db
      .select({ f: column })
      .from(contractSigners)
      .where(and(eq(contractSigners.userId, userId), eq(contractSigners.status, "signed"), isNotNull(column)))
      .orderBy(desc(contractSigners.signedAt))
      .limit(1);
    if (!row?.f) return null;
    const buf = await readSignatureFile(row.f);
    if (!buf || !inspectPng(buf).ok) return null;
    return `data:image/png;base64,${buf.toString("base64")}`;
  };
  return { seal: await load("sealFile"), initials: await load("initialsFile") };
}

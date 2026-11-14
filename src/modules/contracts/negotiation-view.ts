import { faTime } from "@/lib/jalali";
import type { PanelComment } from "@/components/NegotiationPanel";
import type { CommentRow } from "./negotiation";

/** تبدیل ردیف‌های دیتابیس به داده‌ی قابل‌سریال‌شدن برای پنل مذاکره (تاریخ‌ها از پیش فرمت می‌شوند) */
export function toPanelComments(rows: CommentRow[]): PanelComment[] {
  return rows.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    authorName: c.authorName,
    authorSide: c.authorSide,
    visibility: c.visibility,
    kind: c.kind,
    quote: c.quote,
    body: c.body,
    status: c.status,
    at: faTime(c.createdAt),
    resolvedAt: c.resolvedAt ? faTime(c.resolvedAt) : null,
  }));
}

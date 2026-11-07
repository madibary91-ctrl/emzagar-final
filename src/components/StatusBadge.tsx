const MAP: Record<string, { label: string; classes: string; dot: string }> = {
  sent: { label: "ارسال شده", classes: "bg-amber-50 text-amber-800 border border-amber-200/70", dot: "bg-amber-500" },
  signed: { label: "امضا شده", classes: "bg-emerald-50 text-emerald-800 border border-emerald-200/70", dot: "bg-emerald-500" },
  rejected: { label: "رد شده", classes: "bg-rose-50 text-rose-700 border border-rose-200", dot: "bg-rose-400" },
  my_turn: { label: "در انتظار امضای شما", classes: "bg-mint/25 text-ink border border-mint/60", dot: "bg-emerald-500" },
  waiting: { label: "در انتظار نوبت", classes: "bg-stone-100 text-stone-600 border border-stone-200", dot: "bg-stone-400" },
  draft: { label: "پیش‌نویس", classes: "bg-sky-50 text-sky-800 border border-sky-200/70", dot: "bg-sky-500" },
  expired: { label: "منقضی شده", classes: "bg-stone-100 text-stone-600 border border-stone-200", dot: "bg-stone-400" },
  cancelled: { label: "لغو شده", classes: "bg-stone-100 text-stone-600 border border-stone-200", dot: "bg-stone-400" },
  pending: { label: "در انتظار امضا", classes: "bg-amber-50 text-amber-800 border border-amber-200/70", dot: "bg-amber-500" },
};

export default function StatusBadge({ status }: { status: string }) {
  const item = MAP[status] ?? { label: status, classes: "bg-stone-100 text-stone-600", dot: "bg-stone-400" };
  return (
    <span className={`badge ${item.classes}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${item.dot}`} />
      {item.label}
    </span>
  );
}

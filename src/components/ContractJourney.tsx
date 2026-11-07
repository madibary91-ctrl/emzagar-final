import { Check, CircleDot, Hourglass, X } from "lucide-react";
import { faTime } from "@/lib/jalali";

export interface JourneyInput {
  status: string;
  createdAt: Date;
  publishedAt: Date | null;
  signedAt: Date | null;
  approvals: { total: number; approved: number } | null;
  signers: { id: number; label: string; name: string; status: string; signedAt: Date | null }[];
}

type StepState = "done" | "current" | "todo" | "failed";
interface Step {
  key: string;
  title: string;
  sub?: string;
  state: StepState;
}

/** مسیر زندگی قرارداد: پیش‌نویس ← تأیید داخلی ← ارسال ← امضای هر طرف ← نهایی‌شدن (یا رد/لغو/انقضا) */
export function buildJourney(j: JourneyInput): Step[] {
  const steps: Step[] = [];
  steps.push({ key: "draft", title: "تنظیم قرارداد", sub: faTime(j.createdAt), state: "done" });
  if (j.approvals && j.approvals.total > 0) {
    const ok = j.approvals.approved >= j.approvals.total;
    steps.push({ key: "approval", title: "تأیید داخلی", sub: `${j.approvals.approved.toLocaleString("fa-IR")} از ${j.approvals.total.toLocaleString("fa-IR")}`, state: ok || j.status !== "draft" ? "done" : "current" });
  }
  const sent = j.status !== "draft";
  steps.push({ key: "sent", title: "ارسال برای امضا", sub: j.publishedAt ? faTime(j.publishedAt) : undefined, state: sent ? "done" : "todo" });

  let turnFound = false;
  for (const s of j.signers) {
    let state: StepState = "todo";
    if (s.status === "signed") state = "done";
    else if (s.status === "rejected") state = "failed";
    else if (j.status === "sent" && !turnFound) {
      state = "current";
      turnFound = true;
    }
    steps.push({ key: `s${s.id}`, title: `امضای ${s.label}`, sub: s.signedAt ? faTime(s.signedAt) : s.name, state });
  }

  if (j.status === "signed") steps.push({ key: "final", title: "نهایی و آرشیو", sub: j.signedAt ? faTime(j.signedAt) : undefined, state: "done" });
  else if (["rejected", "cancelled", "expired"].includes(j.status)) {
    const label = j.status === "rejected" ? "رد شد" : j.status === "cancelled" ? "لغو شد" : "منقضی شد";
    steps.push({ key: "end", title: label, state: "failed" });
  } else steps.push({ key: "final", title: "نهایی و آرشیو", state: "todo" });
  return steps;
}

export default function ContractJourney(props: JourneyInput) {
  const steps = buildJourney(props);
  const done = steps.filter((s) => s.state === "done").length;
  const pct = Math.round((done / steps.length) * 100);
  return (
    <section aria-label="مسیر قرارداد" className="panel-solid p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-black">مسیر قرارداد</h2>
        <span className="text-xs font-semibold text-ink/72">{pct.toLocaleString("fa-IR")}٪ پیشرفت</span>
      </div>
      <div className="mb-5 h-1.5 overflow-hidden rounded-full bg-stone-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="پیشرفت قرارداد">
        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ol className="thin-scroll flex gap-0 overflow-x-auto pb-1">
        {steps.map((s, i) => {
          const tone =
            s.state === "done" ? "bg-emerald-600 text-white" : s.state === "current" ? "bg-ink text-mint ring-4 ring-mint/30" : s.state === "failed" ? "bg-rose-500 text-white" : "bg-stone-200 text-ink/60";
          return (
            <li key={s.key} className="relative flex min-w-[112px] flex-1 flex-col items-center px-2 text-center" aria-current={s.state === "current" ? "step" : undefined}>
              {i > 0 && <span aria-hidden className={`absolute left-1/2 top-[15px] h-0.5 w-full ${steps[i - 1].state === "done" ? "bg-emerald-500" : "bg-stone-200"}`} />}
              <span className={`relative z-10 grid h-8 w-8 place-items-center rounded-full ${tone}`}>
                {s.state === "done" ? <Check size={16} /> : s.state === "failed" ? <X size={16} /> : s.state === "current" ? <Hourglass size={14} /> : <CircleDot size={14} />}
              </span>
              <b className="mt-2 text-[11px] leading-5">{s.title}</b>
              {s.sub && <span className="mt-0.5 text-[10px] leading-4 text-ink/65">{s.sub}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

import { faTime } from "@/lib/jalali";
import { PRIORITIES, statusMeta } from "@/modules/tickets/meta";

export function TicketStatusBadge({ status }: { status: string }) {
  const m = statusMeta(status);
  return <span className={`badge ${m.badge}`}>{m.label}</span>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  const m = PRIORITIES[priority] ?? PRIORITIES.normal;
  return <span className={`badge ${m.badge}`}>{m.label}</span>;
}

type Msg = { id: number; isStaff: boolean; internal?: boolean; body: string; createdAt: Date; author: string };

/** گفتگوی تیکت: پیام پشتیبان و مشتری با رنگ متفاوت؛ یادداشت داخلی با برچسب جدا */
export function TicketThread({ messages, staffView }: { messages: Msg[]; staffView?: boolean }) {
  return (
    <ol className="space-y-3" aria-label="گفتگوی تیکت">
      {messages.map((m) => {
        const mine = staffView ? m.isStaff : !m.isStaff;
        return (
          <li key={m.id} className={`flex ${mine ? "justify-start" : "justify-end"}`}>
            <div role="status"
              className={`max-w-[92%] rounded-3xl border p-4 sm:max-w-[80%] ${
                m.internal ? "border-amber-200 bg-amber-50" : m.isStaff ? "border-emerald-200 bg-emerald-50" : "border-ink/10 bg-white"
              }`}
            >
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-stone-600">
                <b className="text-ink">{m.isStaff ? `${m.author} · پشتیبانی` : m.author}</b>
                {m.internal && <span className="badge bg-amber-100 text-amber-800">یادداشت داخلی</span>}
                <span>{faTime(m.createdAt)}</span>
              </div>
              <p className="msg-bubble">{m.body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

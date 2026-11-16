import { BadgeCheck, Building2, Eye, Stamp, Users } from "lucide-react";
import StatusBadge from "@/components/StatusBadge";
import { faTime } from "@/lib/jalali";
import { groupByStage, MODE_LABEL, parseSigningMode, stageOf } from "@/modules/signing/stages";

interface RosterSigner {
  id: number;
  position: number;
  stage: number;
  label: string;
  userName: string;
  status: string;
  signedAt: Date | null;
  signatureFile: string | null;
  role: string;
  signerType: string;
  companyName: string;
  companyNationalId: string;
  signatoryTitle: string;
  sealRequired: boolean;
  sealFile: string | null;
  initialsRequired: boolean;
  initialsFile: string | null;
}

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/**
 * خط زمانی امضاکنندگان به‌صورت «مرحله‌ها»: هر مرحله یک گروه است؛ اعضای یک مرحله هم‌زمان امضا می‌کنند.
 * شاهدها، شرکت‌ها، مهر و پاراف با نشان مشخص می‌شوند.
 */
export default function SignerRoster({ contractId, signers, status, signingMode }: { contractId: number; signers: RosterSigner[]; status: string; signingMode: string }) {
  const groups = groupByStage(signers);
  const mode = parseSigningMode(signingMode);
  const pendingStage = groups.find((g) => g.items.some((s) => s.status === "pending"))?.stage;
  const parallelAny = groups.some((g) => g.items.length > 1);
  const witnesses = signers.filter((s) => s.role === "witness").length;

  return (
    <section className="panel-solid p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-black">{parallelAny ? "مراحل امضا" : "ترتیب امضاکنندگان"}</h2>
        <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-[11px] font-bold text-ink/75">{mode === "sequential" && !parallelAny ? MODE_LABEL.sequential : parallelAny && groups.length === 1 ? MODE_LABEL.parallel : MODE_LABEL.staged}</span>
        {witnesses > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2.5 py-0.5 text-[11px] font-bold text-violet-800"><Eye size={12} />{fn(witnesses)} شاهد</span>}
      </div>
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.stage}>
            {(parallelAny || groups.length > 1) && (
              <div className="mb-2 flex items-center gap-2 text-[11px] font-bold text-ink/65">
                {g.items.length > 1 && <Users size={13} />}
                مرحله‌ی {fn(g.index)}
                {g.items.length > 1 ? ` — ${fn(g.items.length)} نفر هم‌زمان` : ""}
              </div>
            )}
            <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {g.items.map((s) => {
                const isTurn = status === "sent" && s.status === "pending" && stageOf(s) === pendingStage;
                const witness = s.role === "witness";
                return (
                  <li key={s.id} className={`flex flex-col gap-2 rounded-2xl border p-4 ${isTurn ? "border-mint bg-mint/10 ring-4 ring-mint/10" : "border-ink/10 bg-stone-50/50"}`}>
                    <div className="flex items-center gap-3">
                      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[13px] font-black ${s.status === "signed" ? "bg-emerald-600 text-white" : s.status === "rejected" ? "bg-rose-500 text-white" : isTurn ? "bg-ink text-mint" : "bg-white text-ink/72"}`}>
                        {s.status === "signed" ? "✓" : fn(s.position)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <b className="block truncate text-xs">{s.label} — {s.userName}</b>
                        {s.signedAt && <span className="mt-0.5 block text-xs text-ink/72">{faTime(s.signedAt)}</span>}
                      </div>
                      {s.status === "signed" && s.signatureFile && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/api/contracts/${contractId}/signature/${s.id}`} alt="امضا" className="signature-image !h-10 !w-20" />
                      )}
                      <StatusBadge status={s.status === "pending" ? (isTurn ? "my_turn" : "waiting") : s.status} />
                    </div>
                    {(witness || s.signerType === "legal" || s.sealRequired || s.initialsRequired) && (
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        {witness && <span className="inline-flex items-center gap-1 rounded-md bg-violet-50 px-1.5 py-0.5 font-bold text-violet-800"><Eye size={11} />شاهد</span>}
                        {s.signerType === "legal" && !witness && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-1.5 py-0.5 font-bold text-blue-900"><Building2 size={11} />{s.companyName}{s.signatoryTitle ? ` — ${s.signatoryTitle}` : ""}</span>
                        )}
                        {s.companyNationalId && !witness && <span dir="ltr" className="font-mono text-ink/60">ID {s.companyNationalId}</span>}
                        {(s.sealRequired || s.sealFile) && (
                          <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-bold ${s.sealFile ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}><Stamp size={11} />{s.sealFile ? "مهر ثبت شد" : "مهر لازم است"}</span>
                        )}
                        {(s.initialsRequired || s.initialsFile) && (
                          <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-bold ${s.initialsFile ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}><BadgeCheck size={11} />{s.initialsFile ? "پاراف ثبت شد" : "پاراف لازم است"}</span>
                        )}
                        {s.sealFile && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`/api/contracts/${contractId}/signature/${s.id}?kind=seal`} alt="مهر شرکتی" className="h-9 w-9 rounded border border-ink/10 bg-white object-contain" />
                        )}
                        {s.initialsFile && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`/api/contracts/${contractId}/signature/${s.id}?kind=initials`} alt="پاراف" className="h-8 w-14 rounded border border-ink/10 bg-white object-contain" />
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

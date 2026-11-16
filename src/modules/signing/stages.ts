/**
 * موتور «مرحله‌ی امضا» (Signing Stages) — ماژول خالص، بدون دیتابیس.
 *
 * مدل واحد برای هر سه شیوه‌ی امضا:
 *  - sequential (ترتیبی)  : هر امضاکننده مرحله‌ی مستقل خودش را دارد (۱، ۲، ۳ …) — رفتار قدیمی، بدون هیچ تغییر.
 *  - parallel   (هم‌زمان) : همه‌ی طرف‌ها در یک مرحله‌اند و هم‌زمان امضا می‌کنند.
 *  - staged     (مرحله‌ای) : ترکیب؛ مثلاً «دو مدیر شرکت هم‌زمان ← سپس طرف مقابل».
 *
 * «شاهد» (witness) هم یک امضاکننده است با نقش دیگر: به‌طور پیش‌فرض «پس از همه‌ی طرف‌ها» (مرحله‌ی آخر) و
 * هم‌زمان با یکدیگر گواهی می‌دهد؛ می‌تواند «هم‌زمان با آخرین مرحله‌ی طرف‌ها» هم باشد.
 *
 * قاعده‌ی نوبت (تنها منبع حقیقت): امضاکننده‌ی در انتظار، «وقتی نوبتش است» که هیچ امضاکننده‌ی در انتظارِ
 * «مرحله‌ی کوچک‌تر» وجود نداشته باشد. مرحله‌ی ۰ (قدیمی) یعنی «مرحله = position».
 */

export type SignerRole = "signer" | "witness";
export type SigningMode = "sequential" | "parallel" | "staged";
export type SignerType = "natural" | "legal";
export type WitnessTiming = "after" | "together";

export const SIGNING_MODES: readonly SigningMode[] = ["sequential", "parallel", "staged"];

export const MODE_LABEL: Record<SigningMode, string> = {
  sequential: "ترتیبی",
  parallel: "هم‌زمان (موازی)",
  staged: "مرحله‌ای",
};

export const ROLE_LABEL: Record<SignerRole, string> = { signer: "امضاکننده", witness: "شاهد" };

export const parseSigningMode = (v: unknown): SigningMode => (SIGNING_MODES.includes(v as SigningMode) ? (v as SigningMode) : "sequential");
export const parseRole = (v: unknown): SignerRole => (v === "witness" ? "witness" : "signer");

export interface StageLike {
  id?: number;
  position: number;
  stage: number;
  status: string;
}

/** مرحله‌ی مؤثر: مقدار صریح، وگرنه position (سازگار با داده‌های قدیمی) */
export const stageOf = (s: { position: number; stage: number }): number => (s.stage > 0 ? s.stage : s.position);

/** امضاکنندگان در انتظارِ «مرحله‌ی فعلی» (کمترین مرحله‌ی دارای امضای باز) */
export function currentStageSigners<T extends StageLike>(signers: T[]): T[] {
  const pending = signers.filter((s) => s.status === "pending");
  if (pending.length === 0) return [];
  const min = Math.min(...pending.map(stageOf));
  return pending.filter((s) => stageOf(s) === min).sort((a, b) => a.position - b.position);
}

/** آیا نوبت این امضاکننده رسیده است؟ */
export function isSignerTurn<T extends StageLike>(signers: T[], signer: { position: number; stage: number; status: string }): boolean {
  if (signer.status !== "pending") return false;
  const mine = stageOf(signer);
  return !signers.some((o) => o.status === "pending" && stageOf(o) < mine);
}

/** نوبتِ کاربرِ مشخص: امضای بازِ او در مرحله‌ی فعلی (اگر چند نقش داشته باشد، اولی) */
export function turnForUser<T extends StageLike & { userId: number }>(signers: T[], userId: number): T | null {
  return currentStageSigners(signers).find((s) => s.userId === userId) ?? null;
}

/** پس از امضای یک نفر: آیا هیچ امضای بازی در مرحله‌ی او (یا قبل‌تر) نمانده است؟ (آنگاه مرحله‌ی بعد باید خبر شود) */
export function stageJustCompleted<T extends StageLike>(signers: T[], signedStage: number): boolean {
  return !signers.some((s) => s.status === "pending" && stageOf(s) <= signedStage);
}

/* ───────── برنامه‌ریزی مرحله‌ها هنگام صدور ───────── */

export interface PlanInput {
  mode: SigningMode;
  /** مرحله‌ی دلخواه هر طرف (فقط در حالت staged؛ ترتیب همان ترتیب طرف‌هاست) */
  partyStages?: (number | null | undefined)[];
  partyCount: number;
  witnessCount: number;
  witnessTiming?: WitnessTiming;
}

export interface PlannedStages {
  parties: number[];
  witnesses: number[];
}

/** مرحله‌ها را فشرده (۱..k) و بدون جای خالی می‌کند */
function compress(values: number[]): number[] {
  const order = [...new Set(values)].sort((a, b) => a - b);
  return values.map((v) => order.indexOf(v) + 1);
}

export function planStages(p: PlanInput): PlannedStages {
  const n = Math.max(0, p.partyCount);
  let parties: number[];
  if (p.mode === "parallel") parties = Array.from({ length: n }, () => 1);
  else if (p.mode === "staged") {
    const raw = Array.from({ length: n }, (_, i) => {
      const v = Math.round(Number(p.partyStages?.[i]));
      return Number.isFinite(v) && v >= 1 ? Math.min(v, 99) : i + 1;
    });
    parties = compress(raw);
  } else parties = Array.from({ length: n }, (_, i) => i + 1);

  const last = parties.length ? Math.max(...parties) : 0;
  const wStage = p.witnessTiming === "together" && last > 0 ? last : last + 1;
  const witnesses = Array.from({ length: Math.max(0, p.witnessCount) }, () => wStage);
  return { parties, witnesses };
}

/** گروه‌بندی امضاکنندگان به‌ترتیب مرحله (برای نمایش خط زمانی) */
export function groupByStage<T extends { position: number; stage: number }>(signers: T[]): { stage: number; index: number; items: T[] }[] {
  const stages = [...new Set(signers.map(stageOf))].sort((a, b) => a - b);
  return stages.map((st, i) => ({ stage: st, index: i + 1, items: signers.filter((s) => stageOf(s) === st).sort((a, b) => a.position - b.position) }));
}

/** آیا امضای این قرارداد «هم‌زمان» است (حداقل یک مرحله با بیش از یک امضاکننده)؟ */
export function hasParallelStage(signers: { position: number; stage: number }[]): boolean {
  return groupByStage(signers).some((g) => g.items.length > 1);
}

/* ───────── امضاکننده‌ی حقوقی (شرکت) ───────── */

export interface LegalInfo {
  signerType: SignerType;
  companyName: string;
  companyNationalId: string;
  signatoryTitle: string;
}

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
export const toLatin = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));

/** شناسه‌ی ملی شخص حقوقی: ۱۱ رقم + رقم کنترلی (الگوریتم رسمی) */
export function isValidCompanyNationalId(raw: string): boolean {
  const id = toLatin(String(raw || "")).trim();
  if (!/^\d{11}$/.test(id)) return false;
  const d = id.split("").map(Number);
  const dec = d[9] + 2;
  const coef = [29, 27, 23, 19, 17, 29, 27, 23, 19, 17];
  const sum = coef.reduce((acc, c, i) => acc + (dec + d[i]) * c, 0);
  let r = sum % 11;
  if (r === 10) r = 0;
  return r === d[10];
}

/**
 * اعتبارسنجی اطلاعات امضاکننده‌ی حقوقی. شناسه‌ی ملی اختیاری است؛ ولی اگر وارد شد باید معتبر باشد.
 * خروجی: مقدار پاک‌سازی‌شده یا پیام خطا.
 */
export function normalizeLegal(input: Partial<LegalInfo> | undefined | null): { ok: true; value: LegalInfo } | { ok: false; error: string } {
  if (!input || input.signerType !== "legal") return { ok: true, value: { signerType: "natural", companyName: "", companyNationalId: "", signatoryTitle: "" } };
  const companyName = String(input.companyName ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (companyName.length < 2) return { ok: false, error: "نام شرکت را وارد کنید" };
  const nid = toLatin(String(input.companyNationalId ?? "")).replace(/\s/g, "");
  if (nid && !isValidCompanyNationalId(nid)) return { ok: false, error: `شناسه‌ی ملی «${companyName}» معتبر نیست (۱۱ رقم)` };
  const signatoryTitle = String(input.signatoryTitle ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return { ok: true, value: { signerType: "legal", companyName, companyNationalId: nid, signatoryTitle } };
}

/** عنوان نمایشی امضاکننده در سند: «شرکت X — مدیرعامل: نام» */
export function partyDisplay(s: { userName: string; role?: string; signerType?: string; companyName?: string; signatoryTitle?: string }): string {
  if (s.role === "witness") return `${s.userName} (شاهد)`;
  if (s.signerType === "legal" && s.companyName) return `${s.companyName} — ${s.signatoryTitle ? `${s.signatoryTitle}: ` : "نماینده: "}${s.userName}`;
  return s.userName;
}

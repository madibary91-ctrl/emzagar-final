/**
 * کلاینت تایپ‌دار شبیه‌ساز برای Vitest و Playwright (فقط fetch؛ بدون وابستگی).
 *
 *   const sim = new SimClient("http://127.0.0.1:4010");
 *   await sim.scenario("kavenegar", "insufficient_credit");
 *   await sim.queue("zarinpal", ["success", "verify@network_error"]);
 *   const { code } = await sim.lastSms("09120000000");
 *   await sim.reset();
 */
import type { LoggedRequest, Payment, ServiceId, SmsRecord } from "./core";

export class SimError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SimError";
  }
}

export interface RequestFilter {
  service?: ServiceId;
  phase?: string;
  since?: number;
  limit?: number;
}

export class SimClient {
  readonly base: string;
  constructor(base: string, private token?: string) {
    this.base = base.replace(/\/+$/, "");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}/__sim/${path}`, {
      method,
      headers: { "content-type": "application/json", ...(this.token ? { "x-sim-token": this.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new SimError(data.error ?? `HTTP ${res.status}`, res.status);
    return data;
  }

  health() {
    return this.call<{ ok: boolean }>("GET", "health");
  }
  state() {
    return this.call<{ services: Record<ServiceId, { scenario: string; latencyMs: number; queue: { scenario: string; remaining: number }[]; calls: number }>; credit: { kavenegar: number; melipayamak: number }; counts: Record<string, number> }>("GET", "state");
  }
  /** سناریوی پیش‌فرض یک سرویس (تا ریست بعدی) */
  scenario(service: ServiceId, scenario: string, latencyMs?: number) {
    return this.call("PUT", `scenario/${service}`, { scenario, latencyMs });
  }
  /** صف سناریوهای «یک‌بار مصرف»؛ هر درخواست مناسب یکی از صف برمی‌دارد */
  queue(service: ServiceId, scenarios: string[]) {
    return this.call("POST", `queue/${service}`, { scenarios });
  }
  queueTimes(service: ServiceId, scenario: string, times: number) {
    return this.call("POST", `queue/${service}`, { scenario, times });
  }
  clearQueue(service: ServiceId) {
    return this.call("DELETE", `queue/${service}`);
  }
  preset(name: string) {
    return this.call("POST", `preset/${name}`);
  }
  reset(service?: ServiceId) {
    return this.call("POST", `reset${service ? `?service=${service}` : ""}`);
  }
  settings(s: { startPay?: "auto" | "manual"; seed?: number }) {
    return this.call("PUT", "settings", s);
  }
  async requests(f: RequestFilter = {}): Promise<LoggedRequest[]> {
    const q = new URLSearchParams();
    if (f.service) q.set("service", f.service);
    if (f.phase) q.set("phase", f.phase);
    if (f.since) q.set("since", String(f.since));
    if (f.limit) q.set("limit", String(f.limit));
    return (await this.call<{ requests: LoggedRequest[] }>("GET", `requests?${q}`)).requests;
  }
  /** شناسه‌ی آخرین درخواست (برای فیلتر «since» در ادامه‌ی تست) */
  async mark(): Promise<number> {
    const all = await this.requests({ limit: 1 });
    return all.length ? all[all.length - 1].id : 0;
  }
  async sms(filter: { to?: string; provider?: string } = {}): Promise<SmsRecord[]> {
    const q = new URLSearchParams();
    if (filter.to) q.set("to", filter.to);
    if (filter.provider) q.set("provider", filter.provider);
    return (await this.call<{ sms: SmsRecord[] }>("GET", `sms?${q}`)).sms;
  }
  /** آخرین پیامک (و کد تایید آن) برای یک شماره؛ اگر نبود SimError(404) */
  lastSms(to?: string) {
    return this.call<{ sms: SmsRecord; code: string | null }>("GET", `sms/last${to ? `?to=${encodeURIComponent(to)}` : ""}`);
  }
  setCredit(provider: "kavenegar" | "melipayamak", value: number) {
    return this.call("PUT", `${provider}/credit`, { value });
  }
  setKavenegarTemplates(names: string[]) {
    return this.call("PUT", "kavenegar/templates", { names });
  }
  async payments(): Promise<Payment[]> {
    return (await this.call<{ payments: Payment[] }>("GET", "zarinpal/payments")).payments;
  }
  payment(authority: string) {
    return this.call<Payment>("GET", `zarinpal/payments/${encodeURIComponent(authority)}`);
  }
  /** نهایی‌کردن پرداخت مثل کاربر؛ follow=true یعنی خود شبیه‌ساز callback برنامه را هم صدا بزند */
  settle(authority: string, outcome: "success" | "cancel" | "fail" | "fake_ok" = "success", follow = false) {
    return this.call<{ status: string; callbackUrl: string; followed?: { status: number; location: string | null } }>("POST", `zarinpal/payments/${encodeURIComponent(authority)}/settle`, { outcome, follow });
  }

  /** اجرای یک بلوک با سناریوی موقت؛ در پایان همان سرویس به حالت عادی برمی‌گردد */
  async with<T>(service: ServiceId, scenario: string, fn: () => Promise<T>): Promise<T> {
    await this.scenario(service, scenario);
    try {
      return await fn();
    } finally {
      await this.scenario(service, "success", 0);
      await this.clearQueue(service);
    }
  }

  /** منتظر می‌ماند تا شرط برقرار شود (مثلاً رسیدن پیامک) */
  async waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 10_000, intervalMs = 100): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await probe().catch(() => null);
      if (v) return v;
      if (Date.now() > end) throw new SimError("زمان انتظار برای شرط شبیه‌ساز تمام شد", 408);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

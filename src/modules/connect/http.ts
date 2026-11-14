import { NextResponse } from "next/server";
import { requestOrigin } from "@/modules/api/service";
import { clientIpFrom } from "@/lib/request";
import { ConnectError } from "./service";

/** آدرس عمومی ابر؛ APP_URL (در production) بر هدرهای قابل جعل اولویت دارد */
export function cloudOrigin(req: Request): string {
  return requestOrigin(req);
}

export function clientIp(req: Request): string {
  return clientIpFrom((n) => req.headers.get(n));
}

const NO_STORE = { "Cache-Control": "no-store" };

export const okJson = (body: Record<string, unknown>, status = 200) => NextResponse.json({ ok: true, ...body }, { status, headers: NO_STORE });

export function failJson(e: unknown) {
  if (e instanceof ConnectError) return NextResponse.json({ ok: false, error: e.code, detail: e.message }, { status: e.status, headers: NO_STORE });
  console.error("[connect]", e);
  return NextResponse.json({ ok: false, error: "server_error" }, { status: 500, headers: NO_STORE });
}

export const errJson = (status: number, error: string, extra?: Record<string, unknown>) =>
  NextResponse.json({ ok: false, error, ...extra }, { status, headers: NO_STORE });

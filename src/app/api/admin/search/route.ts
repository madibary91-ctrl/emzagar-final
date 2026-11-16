import { NextResponse } from "next/server";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "@/db";
import { contracts, templates, users } from "@/db/schema";
import { getTeamForApi } from "@/modules/tenancy/context";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** جستجوی سراسری برای Command Palette (Ctrl+K): فقط داده‌های فضای کاری فعلی کاربر */
export async function GET(req: Request) {
  const team = await getTeamForApi("view");
  if (!team) return json({ ok: false, results: [] }, 403);
  if (!rateLimit(`search:${team.id}`, 90, 60_000).ok) return json({ ok: false, results: [] }, 429);

  const q = (new URL(req.url).searchParams.get("q") || "").trim().slice(0, 60);
  if (q.length < 2) return json({ ok: true, results: [] });
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  const [cs, ts] = await Promise.all([
    db
      .select({ id: contracts.id, number: contracts.number, title: contracts.title, status: contracts.status, customer: users.name })
      .from(contracts)
      .innerJoin(users, eq(users.id, contracts.customerId))
      .where(and(eq(contracts.workspaceId, team.workspaceId), or(ilike(contracts.number, like), ilike(contracts.title, like), ilike(users.name, like), ilike(users.email, like), ilike(users.mobile, like))))
      .orderBy(desc(contracts.issuedAt))
      .limit(7),
    db.select({ id: templates.id, title: templates.title }).from(templates).where(and(eq(templates.workspaceId, team.workspaceId), ilike(templates.title, like))).limit(4),
  ]);

  return json({
    ok: true,
    results: [
      ...cs.map((c) => ({ type: "contract", href: `/contracts/${c.id}`, title: c.title, sub: `${c.number} — ${c.customer}`, status: c.status })),
      ...ts.map((t) => ({ type: "template", href: `/admin/templates/${t.id}`, title: t.title, sub: "قالب", status: "" })),
    ],
  });
}

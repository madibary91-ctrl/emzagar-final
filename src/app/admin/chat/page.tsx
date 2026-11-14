import type { Metadata } from "next";
import Shell from "@/components/Shell";
import ChatConsole from "@/components/chat/ChatConsole";
import { requireTeam } from "@/modules/tenancy/context";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "گفتگوی زنده با مشتریان" };

/** کنسول گفتگوی زنده‌ی تیم صادرکننده: امضاکنندگان و پرداخت‌کنندگان قراردادهای همین فضای کاری */
export default async function AdminChatPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const team = await requireTeam("write");
  const { c } = await searchParams;
  const initialCode = c && /^[A-Za-z0-9_-]{8,40}$/.test(c) ? c : undefined;
  return (
    <Shell user={team} wide>
      <ChatConsole queue="workspace" initialCode={initialCode} staffName={team.name} staffId={team.id} />
    </Shell>
  );
}

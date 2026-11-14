import type { Metadata } from "next";
import Shell from "@/components/Shell";
import ChatConsole from "@/components/chat/ChatConsole";
import { requirePlatformAdmin } from "@/modules/platform/admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "گفتگوی زنده — پشتیبانی پلتفرم" };

/** کنسول گفتگوی زنده‌ی مدیر کل: همه‌ی مشتریانی که با «پشتیبانی پلتفرم» گفتگو می‌کنند */
export default async function PlatformChatPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const admin = await requirePlatformAdmin();
  const { c } = await searchParams;
  const initialCode = c && /^[A-Za-z0-9_-]{8,40}$/.test(c) ? c : undefined;
  return (
    <Shell user={admin} wide>
      <ChatConsole queue="platform" initialCode={initialCode} staffName={admin.name} staffId={admin.id} />
    </Shell>
  );
}

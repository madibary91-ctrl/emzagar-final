import { POST as handshakePOST } from "@/app/api/v1/sync/handshake/route";

/** دست‌دادن همگام‌سازی (ساخت راز Push) برای فضای کاری یک اتصال وردپرس */
export async function handshakePOSTForTest(apiKey: string) {
  const res = await handshakePOST(
    new Request("http://localhost:3000/api/v1/sync/handshake", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ capabilities: "push,pull,orders" }),
    }),
  );
  return res.status;
}

"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, LoaderCircle } from "lucide-react";
import { unlockLinkAction, type LinkState } from "@/modules/links/actions";

export default function LinkUnlockForm({ code }: { code: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<LinkState, FormData>(unlockLinkAction, {});
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="code" value={code} />
      <div>
        <label className="label" htmlFor="password">رمز لینک</label>
        <input id="password" name="password" type="password" dir="ltr" required autoFocus autoComplete="off" className="input" />
      </div>
      {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{state.error}</p>}
      <button disabled={pending} className="btn-primary w-full !min-h-[50px]">
        {pending ? <LoaderCircle size={17} className="animate-spin" /> : <KeyRound size={17} />}
        باز کردن قرارداد
      </button>
    </form>
  );
}

"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export default function CopyButton({ text, label = "کپی" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary btn-sm"
      onClick={async () => {
        const abs = text.startsWith("/") ? `${window.location.origin}${text}` : text;
        await navigator.clipboard.writeText(abs).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {done ? "کپی شد" : label}
    </button>
  );
}

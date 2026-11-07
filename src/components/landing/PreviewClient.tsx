"use client";

import { useEffect, useState } from "react";
import { sanitizeDoc, type LandingDoc } from "@/modules/landing/schema";
import { LandingRenderer, type RendererCtx } from "./LandingRenderer";

/** صفحه‌ی داخل iframe ویرایشگر: پیش‌نویس را زنده از پنجره‌ی والد (هم‌مبدأ) می‌گیرد */
export default function PreviewClient({ initial, ctx }: { initial: LandingDoc; ctx: RendererCtx }) {
  const [doc, setDoc] = useState(initial);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== window.parent) return;
      const d = e.data as { type?: string; doc?: unknown; sel?: string | null } | null;
      if (!d) return;
      if (d.type === "doc") setDoc(sanitizeDoc(d.doc));
      else if (d.type === "select") setSelected(typeof d.sel === "string" ? d.sel : null);
      else if (d.type === "scroll" && typeof d.sel === "string") {
        if (d.sel.startsWith("sec:")) document.getElementById(d.sel.slice(4))?.scrollIntoView({ behavior: "smooth", block: "start" });
        else if (d.sel === "g:footer") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        else window.scrollTo({ top: 0, behavior: "smooth" });
      }
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "ready" }, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <LandingRenderer
      doc={doc}
      ctx={ctx}
      editing
      selected={selected}
      onSelect={(sel) => {
        setSelected(sel);
        window.parent.postMessage({ type: "select", sel }, window.location.origin);
      }}
    />
  );
}

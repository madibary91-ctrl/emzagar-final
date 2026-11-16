"use client";

import { useEffect } from "react";

/**
 * مدیریت یکپارچه‌ی «ماندگاری پیام‌های خطا» در تمام فرم‌ها و صفحه‌های سیستم.
 *
 * ریشه‌ی مشکل: پیام خطا (role="alert") از state فرم (useActionState / useState) یا از query-string صفحه
 * (?error=…) می‌آید و تا نتیجه‌ی بعدیِ همان فرم در DOM می‌ماند؛ هیچ‌چیز آن را با ویرایش فیلد، عوض‌کردن تب یا
 * برگشت به صفحه پاک نمی‌کرد. به‌جای دست‌کاری ۵۰ فرم، همین یک مدیر سراسری قرارداد زیر را اجرا می‌کند:
 *
 *  • ویرایش هر فیلد (input/change) ← خطاهای همان فرم/کادر پنهان می‌شود؛
 *  • کلیک روی یک تب (role="tab") ← خطاهای همان پنل پنهان می‌شود؛
 *  • برگشت به زبانه‌ی مرورگر یا بازگشت با «عقب» (bfcache) ← خطاهایی که کاربر قبلاً دیده پنهان می‌شود؛
 *  • ارسال دوباره‌ی فرم ← خطای هم‌متن دوباره دیده می‌شود (اگر سرور باز همان خطا را بدهد)؛
 *  • خطای تازه با متن متفاوت همیشه دیده می‌شود (MutationObserver)؛
 *  • پارامترهای ?error=… از نشانی صفحه پاک می‌شوند تا با رفرش برنگردند.
 *
 * استثنا: عنصری که data-persist داشته باشد (مثل «کلید بازیابی که فقط یک‌بار نمایش داده می‌شود») هرگز پنهان نمی‌شود.
 * پنهان‌سازی فقط با صفت data-dismissed (و یک قاعده‌ی CSS) انجام می‌شود و درخت DOM ی React دست‌نخورده می‌ماند.
 */

const ALERT = '[role="alert"]:not([data-persist])';
const FIELD = "input, select, textarea, [contenteditable=''], [contenteditable='true']";
const FLASH_PARAM = /(^|_)error$|^err$/;

function scopeOf(el: Element): ParentNode {
  const explicit = el.closest("[data-feedback-scope]");
  if (explicit) return explicit;
  const form = el.closest("form");
  if (form) {
    const p = form.parentElement;
    // کادر پیرامونِ فرم (مثل کارتی که پیام را بالای فرم‌ها نشان می‌دهد)؛ هرگز کل صفحه
    if (p && p.tagName !== "MAIN" && p.tagName !== "BODY" && p.tagName !== "HTML") return p;
    return form;
  }
  return el.closest(".card, .panel-solid, section, article, dialog") ?? el.parentElement ?? document.body;
}

function stripFlashParams() {
  try {
    const url = new URL(window.location.href);
    let changed = false;
    for (const k of Array.from(url.searchParams.keys())) {
      if (FLASH_PARAM.test(k)) {
        url.searchParams.delete(k);
        changed = true;
      }
    }
    if (changed) window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  } catch {
    /* بی‌اثر */
  }
}

function dismiss(scope: ParentNode, onlySeen = false) {
  let any = false;
  scope.querySelectorAll<HTMLElement>(ALERT).forEach((a) => {
    if (a.hasAttribute("data-dismissed")) return;
    if (onlySeen && !a.hasAttribute("data-seen")) return;
    a.setAttribute("data-dismissed", "1");
    a.setAttribute("data-dismissed-text", a.textContent ?? "");
    a.removeAttribute("data-seen");
    any = true;
  });
  if (any) stripFlashParams();
}

function reveal(scope: ParentNode) {
  scope.querySelectorAll<HTMLElement>("[role='alert'][data-dismissed]").forEach((a) => {
    a.removeAttribute("data-dismissed");
    a.removeAttribute("data-dismissed-text");
  });
}

export default function FeedbackManager() {
  useEffect(() => {
    const onEdit = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element) || !t.matches(FIELD)) return;
      if (t.closest("[role='alert']")) return;
      dismiss(scopeOf(t));
    };

    const onSubmit = (e: Event) => {
      const t = e.target;
      if (t instanceof Element) reveal(scopeOf(t));
    };

    const onClick = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const tab = t.closest("[role='tab']");
      if (tab) {
        const list = tab.closest("[role='tablist']");
        dismiss(tab.closest("[data-feedback-scope]") ?? list?.parentElement?.parentElement ?? list?.parentElement ?? document.body);
        return;
      }
      const btn = t.closest("button:not([disabled]), input[type='submit']");
      if (btn && !btn.closest("[role='alert']")) reveal(scopeOf(btn));
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        document.querySelectorAll(ALERT).forEach((a) => {
          if (!a.hasAttribute("data-dismissed")) a.setAttribute("data-seen", "1");
        });
      } else {
        dismiss(document, true);
      }
    };

    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) dismiss(document);
    };

    // خطای تازه با متن دیگر روی همان عنصر React (به‌روزرسانی متن) باید دیده شود
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        const node = r.target;
        const el = node instanceof Element ? node : node.parentElement;
        const a = el?.closest<HTMLElement>("[role='alert'][data-dismissed]");
        if (a && (a.textContent ?? "") !== a.getAttribute("data-dismissed-text")) {
          a.removeAttribute("data-dismissed");
          a.removeAttribute("data-dismissed-text");
        }
      }
    });
    mo.observe(document.body, { subtree: true, childList: true, characterData: true });

    document.addEventListener("input", onEdit, true);
    document.addEventListener("change", onEdit, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      mo.disconnect();
      document.removeEventListener("input", onEdit, true);
      document.removeEventListener("change", onEdit, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  return null;
}

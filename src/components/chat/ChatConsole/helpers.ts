"use client";
import { type StaffCounts, type StaffListItem } from "@/modules/chat/meta";

export type Filter = "open" | "mine" | "unassigned" | "closed";
export type Inbox = { items: StaffListItem[]; counts: StaffCounts; online: boolean };
export type ThreadState = { status: "open" | "closed"; assigneeId: number | null; requesterTyping: boolean; requesterOnline: boolean; requesterReadId: number; rating: number | null; hasTicket: boolean; unread: number };
export const CONTRACT_STATUS: Record<string, string> = { draft: "پیش‌نویس", sent: "در انتظار امضا", signed: "امضاشده", rejected: "ردشده", expired: "منقضی", cancelled: "لغوشده" };
export const SIGNER_STATUS: Record<string, string> = { pending: "منتظر امضا", signed: "امضا کرده", rejected: "رد کرده" };
export const SOUND_KEY = "emz-chat-sound";
export const api = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export function beep() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ac = new AC();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ac.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.35);
    o.connect(g).connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 0.4);
    setTimeout(() => void ac.close(), 600);
  } catch {
    /* بدون صدا */
  }
}

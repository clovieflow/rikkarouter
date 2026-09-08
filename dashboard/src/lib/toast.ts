// Toast store — minimal push/expire queue for transient notices (§48).
// Rendered by ToastHost; mount once near the app root (see ToastHost docs).
import { writable } from "svelte/store";

export type ToastKind = "ok" | "err" | "info";
export interface ToastItem {
  id: number;
  kind: ToastKind;
  msg: string;
}

let seq = 0;
export const toasts = writable<ToastItem[]>([]);

export function toast(msg: string, kind: ToastKind = "info", ms = 3600): number {
  const id = ++seq;
  toasts.update((t) => [...t.slice(-3), { id, kind, msg }]);
  setTimeout(() => dismiss(id), ms);
  return id;
}

export function dismiss(id: number): void {
  toasts.update((t) => t.filter((x) => x.id !== id));
}

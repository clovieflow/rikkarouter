import { setting } from "../shared/db.ts";

// Telegram ops alerts for a solo operator. No-op unless configured:
//   RIKKA_TELEGRAM_BOT_TOKEN + RIKKA_TELEGRAM_CHAT_ID (env), or the same keys
//   in meta settings (dashboard Settings page). Env wins when both are set.

function cfg(): { token: string; chat: string } {
  let token = process.env.RIKKA_TELEGRAM_BOT_TOKEN ?? "";
  let chat = process.env.RIKKA_TELEGRAM_CHAT_ID ?? "";
  try {
    if (!token) token = setting("telegram_bot_token") ?? "";
    if (!chat) chat = setting("telegram_chat_id") ?? "";
  } catch {}
  return { token, chat };
}

export function telegramConfigured(): boolean {
  const { token, chat } = cfg();
  return token !== "" && chat !== "";
}

const lastSent = new Map<string, number>();

/** Throttled fire-and-forget alert. key dedups; minIntervalMs guards storms. */
export async function notify(key: string, text: string, minIntervalMs = 3_600_000): Promise<boolean> {
  const { token, chat } = cfg();
  if (!token || !chat) return false;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < minIntervalMs) return false;
  lastSent.set(key, now);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `rikka: ${text}`, disable_notification: false }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const hits429: number[] = [];

/** Call on every upstream 429: alerts when 20+ hit inside 5 minutes (per process). */
export function note429(provider: string): void {
  const now = Date.now();
  hits429.push(now);
  while (hits429.length && hits429[0]! < now - 300_000) hits429.shift();
  if (hits429.length >= 20) {
    hits429.length = 0;
    void notify("storm:429", `429 storm: 20+ rate limits in 5 min (latest: ${provider}) — consider backing off or rotating egress`, 1_800_000);
  }
}

export async function telegramTest(to: string): Promise<{ ok: boolean; error?: string }> {
  const { token, chat } = cfg();
  const target = to || chat;
  if (!token || !target) return { ok: false, error: "set RIKKA_TELEGRAM_BOT_TOKEN and chat id first" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: target, text: "rikka: test alert — notifications work" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { ok: false, error: `telegram ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

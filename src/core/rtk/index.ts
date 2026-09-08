// derived from 9router (MIT) open-sse/rtk — ported to canonical types; windowed slice with header/marker.
import type { CanonicalRequest } from "../types.ts";

const DEFAULT_THRESHOLD = 4000;
const HEAD_CHARS = 1500;
const TAIL_CHARS = 1500;

/**
 * Compress large tool_result contents by windowed slicing.
 *
 * For each `tool_result` part where `content.length > threshold` (default 4000,
 * or `opts.maxChars` when provided), the content is replaced with:
 *
 *   `[tool_result N: <toolCallId> — trimmed]\n` +
 *   `first 1500 chars\n` +
 *   `...[trimmed K chars]...\n` +
 *   `last 1500 chars`
 *
 * where K = originalLength - 3000 and N is a 1-based counter over trimmed
 * results in encounter order (deterministic).
 *
 * Small inputs (<= threshold, including empty) are returned lossless and
 * without a header. The original request is never mutated; a new
 * CanonicalRequest is returned (identity-preserved when nothing was trimmed).
 * toolCallId is preserved on the part and mirrored in the header.
 */
export function compressToolResults(
  req: CanonicalRequest,
  opts?: { maxChars?: number },
): CanonicalRequest {
  const threshold = opts?.maxChars ?? DEFAULT_THRESHOLD;
  // Clamp to avoid degenerate windows — at least head+tail must fit.
  const effectiveThreshold = threshold < 0 ? 0 : threshold;

  let trimmedCounter = 0;
  let anyTrimmed = false;

  const newMessages = req.messages.map((msg) => {
    let msgChanged = false;
    const newContent = msg.content.map((part) => {
      if (part.type !== "tool_result") return part;
      const content = part.content;
      if (content.length <= effectiveThreshold) return part;

      trimmedCounter += 1;
      msgChanged = true;
      const trimmedChars = content.length - HEAD_CHARS - TAIL_CHARS;
      const safeTrimmed = trimmedChars > 0 ? trimmedChars : content.length - effectiveThreshold;
      const marker = `...[trimmed ${Math.max(0, safeTrimmed)} chars]...`;
      const header = `[tool_result ${trimmedCounter}: ${part.toolCallId} — trimmed]`;
      let head: string;
      let tail: string;
      if (trimmedChars > 0) {
        head = content.slice(0, HEAD_CHARS);
        tail = content.slice(-TAIL_CHARS);
      } else {
        const half = Math.floor(effectiveThreshold / 2);
        head = content.slice(0, half);
        tail = content.slice(-Math.ceil(effectiveThreshold / 2));
      }
      const newText = `${header}\n${head}\n${marker}\n${tail}`;

      return { ...part, content: newText };
    });

    if (!msgChanged) return msg;
    anyTrimmed = true;
    return { ...msg, content: newContent };
  });

  if (!anyTrimmed) return req;
  return { ...req, messages: newMessages };
}

function totalToolResultChars(req: CanonicalRequest): number {
  let total = 0;
  for (const m of req.messages) {
    for (const p of m.content) {
      if (p.type === "tool_result") total += p.content.length;
    }
  }
  return total;
}

/**
 * Estimate character-level saving ratio between two requests.
 * Returns (originalChars - compressedChars) / originalChars, in [0, 1].
 * When original has no tool_result chars, returns 0.
 */
export function estimateSaving(original: CanonicalRequest, compressed: CanonicalRequest): number {
  const before = totalToolResultChars(original);
  if (before === 0) return 0;
  const after = totalToolResultChars(compressed);
  const saved = before - after;
  if (saved <= 0) return 0;
  return saved / before;
}

export const __internals = {
  DEFAULT_THRESHOLD,
  HEAD_CHARS,
  TAIL_CHARS,
};

// derived from 9router (MIT) — open-sse/translator/formats/gemini.js and open-sse/translator/request/{openai-to-gemini,gemini-to-openai}.js
// Gemini ⇄ canonical (request, streaming, encoder, collector).
// Pattern informed by 9router open-sse/translator (MIT); rewritten single-source.
import type {
  CanonicalEvent,
  CanonicalMessage,
  CanonicalRequest,
  ContentPart,
  FinishReason,
  ToolSpec,
} from "../types.ts";

// ---------- wire types ----------
export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
  inlineData?: { mimeType?: string; mime_type?: string; data: string };
  inline_data?: { mimeType?: string; mime_type?: string; data: string };
  fileData?: { fileUri?: string; file_uri?: string; mimeType?: string; mime_type?: string };
  file_data?: { fileUri?: string; file_uri?: string; mimeType?: string; mime_type?: string };
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  function_call?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response?: unknown; id?: string };
  function_response?: { name: string; response?: unknown; id?: string };
}

export interface GeminiContent {
  role: string; // "user" | "model"
  parts: GeminiPart[];
}

export interface GeminiRequest {
  contents?: GeminiContent[];
  systemInstruction?: { role?: string; parts: GeminiPart[] };
  system_instruction?: { role?: string; parts: GeminiPart[] };
  tools?: Array<{ functionDeclarations?: Array<{ name: string; description?: string; parameters?: unknown }> }>;
  generationConfig?: {
    maxOutputTokens?: number;
    max_output_tokens?: number;
    temperature?: number;
    topP?: number;
    top_p?: number;
    topK?: number;
    top_k?: number;
    stopSequences?: string[];
    stop_sequences?: string[];
    candidateCount?: number;
  };
  generation_config?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
  safetySettings?: unknown;
  model?: string;
  [k: string]: unknown;
}

// ---------- helpers ----------

function extractTextFromParts(parts: GeminiPart[]): string {
  return parts
    .filter((p) => typeof p.text === "string" && p.text.length > 0 && p.thought !== true)
    .map((p) => p.text as string)
    .join("");
}

function extractReasoningFromParts(parts: GeminiPart[]): string {
  return parts
    .filter((p) => p.thought === true && typeof p.text === "string" && (p.text as string).length > 0)
    .map((p) => p.text as string)
    .join("");
}

function encodeDataUri(mime: string, data: string): string {
  return `data:${mime};base64,${data}`;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseDataUrl(url: string): { mime: string; data: string } | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma === -1) return null;
  const mimePart = url.slice(5, comma);
  const mime = mimePart.split(";")[0] ?? "image/png";
  const data = url.slice(comma + 1);
  return { mime, data };
}

function toInlineData(url: string): { inlineData: { mimeType: string; data: string } } | { fileData: { fileUri: string; mimeType: string } } {
  const parsed = parseDataUrl(url);
  if (parsed) return { inlineData: { mimeType: parsed.mime, data: parsed.data } };
  return { fileData: { fileUri: url, mimeType: "image/*" } };
}

function normalizeRole(role: string | undefined): "user" | "model" {
  if (role === "model" || role === "assistant") return "model";
  return "user";
}

// ---------- request: Gemini → canonical ----------

const GEMINI_KNOWN_KEYS = new Set([
  "contents",
  "systemInstruction",
  "system_instruction",
  "tools",
  "generationConfig",
  "generation_config",
  "safetySettings",
  "safety_settings",
  "model",
]);

export function geminiToCanonical(body: GeminiRequest): CanonicalRequest {
  const messages: CanonicalMessage[] = [];

  // systemInstruction → system message
  const sysRaw = (body.systemInstruction ?? body.system_instruction) as { parts?: GeminiPart[] } | undefined;
  if (sysRaw?.parts && Array.isArray(sysRaw.parts)) {
    const text = extractTextFromParts(sysRaw.parts);
    const reasoning = extractReasoningFromParts(sysRaw.parts);
    if (text || reasoning) {
      const content: ContentPart[] = [];
      if (text) content.push({ type: "text", text });
      // reasoning on system message is unusual but preserve if present
      const msg: CanonicalMessage = { role: "system", content: content.length ? content : [{ type: "text", text: "" }] };
      if (reasoning) msg.reasoning = reasoning;
      messages.push(msg);
    }
  }

  const contents = body.contents ?? [];
  for (const content of contents) {
    if (!content.parts || !Array.isArray(content.parts)) continue;

    const gemRole = normalizeRole(content.role);
    const textParts: string[] = [];
    let reasoning = "";
    const toolCalls: ContentPart[] = [];
    const toolResults: ContentPart[] = [];
    const images: ContentPart[] = [];
    let hasFunctionResponse = false;

    for (const part of content.parts) {
      // thought signature alone carries no text; skip unless it has text
      const hasThoughtSig = part.thoughtSignature !== undefined || part.thought_signature !== undefined;
      const isThought = part.thought === true;

      if (part.text !== undefined && part.text !== "") {
        if (isThought) {
          reasoning += part.text;
        } else if (hasThoughtSig) {
          // part carries a signature + text: treat thought-tagged text as reasoning
          if (isThought) reasoning += part.text;
          else textParts.push(part.text);
        } else {
          textParts.push(part.text);
        }
      }

      const inline = part.inlineData ?? part.inline_data;
      if (inline?.data) {
        const mime = inline.mimeType ?? inline.mime_type ?? "image/png";
        images.push({ type: "image", url: encodeDataUri(mime, inline.data) });
      }
      const fileD = part.fileData ?? part.file_data;
      if (fileD?.fileUri ?? fileD?.file_uri) {
        const uri = (fileD.fileUri ?? fileD.file_uri) as string;
        images.push({ type: "image", url: uri });
      }

      const fc = part.functionCall ?? part.function_call;
      if (fc) {
        const id = fc.id ?? `call_${fc.name}`;
        const args = fc.args != null ? JSON.stringify(fc.args) : "{}";
        toolCalls.push({ type: "tool_call", id, name: fc.name, args });
      }

      const fr = part.functionResponse ?? part.function_response;
      if (fr) {
        hasFunctionResponse = true;
        const toolCallId = fr.id ?? `call_${fr.name}`;
        // Gemini wraps user tool output as { response: { result: ... } } or plain object
        let frResp: unknown = fr.response;
        // Unwrap { result: X } if that's the only layer
        if (frResp != null && typeof frResp === "object" && !Array.isArray(frResp)) {
          const rec = frResp as Record<string, unknown>;
          if ("result" in rec && Object.keys(rec).length === 1) {
            frResp = rec["result"];
          }
        }
        let contentStr: string;
        if (typeof frResp === "string") contentStr = frResp;
        else if (frResp == null) contentStr = "";
        else {
          try {
            contentStr = JSON.stringify(frResp);
          } catch {
            contentStr = String(frResp);
          }
        }
        toolResults.push({ type: "tool_result", toolCallId, content: contentStr });
      }
    }

    // Gemini functionResponse content maps to one tool message per response part.
    // If a single Gemini content bundles multiple functionResponses, emit separate canonical tool messages.
    if (hasFunctionResponse) {
      for (const tr of toolResults) {
        messages.push({ role: "tool", content: [tr] });
      }
      // If there were also text parts alongside functionResponse (rare), preserve them as user text
      if (textParts.length || images.length) {
        const content: ContentPart[] = [];
        if (textParts.length) content.push({ type: "text", text: textParts.join("") });
        for (const im of images) content.push(im);
        if (content.length) messages.push({ role: "user", content });
      }
      continue;
    }

    if (toolCalls.length > 0) {
      const content: ContentPart[] = [];
      if (textParts.length) content.push({ type: "text", text: textParts.join("") });
      for (const im of images) content.push(im);
      for (const tc of toolCalls) content.push(tc);
      const msg: CanonicalMessage = { role: "assistant", content };
      if (reasoning) msg.reasoning = reasoning;
      messages.push(msg);
      continue;
    }

    // regular user / model text
    if (gemRole === "model") {
      const content: ContentPart[] = [];
      if (textParts.length) content.push({ type: "text", text: textParts.join("") });
      for (const im of images) content.push(im);
      if (content.length === 0 && !reasoning) continue;
      const msg: CanonicalMessage = { role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] };
      if (reasoning) msg.reasoning = reasoning;
      messages.push(msg);
    } else {
      const content: ContentPart[] = [];
      if (textParts.length) content.push({ type: "text", text: textParts.join("") });
      for (const im of images) content.push(im);
      if (content.length === 0 && !reasoning) continue;
      // reasoning on user side is not canonical, but keep as text if present
      if (reasoning && !textParts.length) content.push({ type: "text", text: reasoning });
      messages.push({ role: "user", content });
    }
  }

  // tools → ToolSpec
  let tools: ToolSpec[] | undefined;
  if (body.tools && Array.isArray(body.tools)) {
    const decls: ToolSpec[] = [];
    for (const tool of body.tools) {
      const fds = tool.functionDeclarations ?? (tool as unknown as { function_declarations?: unknown[] }).function_declarations;
      if (!Array.isArray(fds)) continue;
      for (const fd of fds as Array<{ name: string; description?: string; parameters?: unknown }>) {
        decls.push({
          name: fd.name,
          ...(fd.description ? { description: fd.description } : {}),
          parameters: fd.parameters ?? { type: "object", properties: {} },
        });
      }
    }
    if (decls.length) tools = decls;
  }

  const gcRaw = (body.generationConfig ?? body.generation_config) as GeminiRequest["generationConfig"] | undefined;
  const maxTokens = gcRaw?.maxOutputTokens ?? gcRaw?.max_output_tokens;
  const temperature = gcRaw?.temperature;
  const topP = gcRaw?.topP ?? gcRaw?.top_p;
  const stopRaw = gcRaw?.stopSequences ?? gcRaw?.stop_sequences;

  const extras: Record<string, unknown> = {};
  for (const k of Object.keys(body)) {
    if (!GEMINI_KNOWN_KEYS.has(k)) extras[k] = (body as Record<string, unknown>)[k];
  }

  return {
    model: (body.model as string) ?? "gemini",
    messages,
    ...(tools ? { tools } : {}),
    stream: false,
    ...(maxTokens != null ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(stopRaw?.length ? { stop: stopRaw } : {}),
    ...(Object.keys(extras).length ? { extras } : {}),
  };
}

// ---------- request: canonical → Gemini wire ----------

function canonicalToGeminiPartsForText(text: string): GeminiPart[] {
  if (!text) return [];
  return [{ text }];
}

export function canonicalToGemini(req: CanonicalRequest): GeminiRequest {
  // systemInstruction: first system message's text
  let systemInstruction: { role: string; parts: GeminiPart[] } | undefined;
  const nonSystemMessages = req.messages.filter((m) => m.role !== "system");
  const systemMessages = req.messages.filter((m) => m.role === "system");
  if (systemMessages.length) {
    const sysText = systemMessages.map((m) => m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("")).join("\n\n");
    // include reasoning as thought part if present
    const parts: GeminiPart[] = [];
    const reasoning = systemMessages.map((m) => m.reasoning ?? "").join("");
    if (reasoning) parts.push({ thought: true, text: reasoning });
    if (sysText) parts.push({ text: sysText });
    if (parts.length) systemInstruction = { role: "user", parts };
  }

  // Build id → name map for functionResponse naming
  const idToName = new Map<string, string>();
  for (const m of req.messages) {
    for (const p of m.content) {
      if (p.type === "tool_call") {
        idToName.set(p.id, p.name);
      }
    }
  }

  const contents: GeminiContent[] = [];
  // Coalesce consecutive tool messages into one Gemini user content
  let pendingToolParts: GeminiPart[] = [];
  const flushToolParts = () => {
    if (pendingToolParts.length) {
      contents.push({ role: "user", parts: pendingToolParts });
      pendingToolParts = [];
    }
  };

  for (const m of nonSystemMessages) {
    if (m.role === "tool") {
      for (const p of m.content) {
        if (p.type === "tool_result") {
          const name = idToName.get(p.toolCallId) ?? p.toolCallId;
          // Try to parse content as JSON; wrap as { result: parsed } to match Gemini convention
          const parsed = tryParseJson(p.content);
          let response: unknown;
          if (parsed !== null && typeof parsed === "object") {
            response = { result: parsed };
          } else if (parsed !== null) {
            response = { result: parsed };
          } else {
            response = { result: p.content };
          }
          pendingToolParts.push({
            functionResponse: { name, id: p.toolCallId, response: response as Record<string, unknown> },
          });
        } else if (p.type === "text") {
          // tool message with text fallback
          pendingToolParts.push({ text: p.text });
        }
      }
      continue;
    }

    // flush any pending tool responses before a non-tool turn
    flushToolParts();

    if (m.role === "user") {
      const parts: GeminiPart[] = [];
      for (const p of m.content) {
        if (p.type === "text") parts.push(...canonicalToGeminiPartsForText(p.text));
        else if (p.type === "image") {
          const conv = toInlineData(p.url);
          if ("inlineData" in conv) parts.push({ inlineData: conv.inlineData });
          else parts.push({ fileData: conv.fileData });
        } else if (p.type === "tool_result") {
          const name = idToName.get(p.toolCallId) ?? p.toolCallId;
          const parsed = tryParseJson(p.content);
          parts.push({ functionResponse: { name, response: parsed !== null ? { result: parsed } : { result: p.content }, ...(p.toolCallId ? { id: p.toolCallId } : {}) } } as unknown as GeminiPart);
        }
      }
      if (parts.length) contents.push({ role: "user", parts });
    } else if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.reasoning) parts.push({ thought: true, text: m.reasoning });
      for (const p of m.content) {
        if (p.type === "text") {
          if (p.text) parts.push({ text: p.text });
        } else if (p.type === "tool_call") {
          let args: Record<string, unknown>;
          try {
            args = p.args ? (JSON.parse(p.args) as Record<string, unknown>) : {};
          } catch {
            args = {};
          }
          parts.push({ functionCall: { name: p.name, args, id: p.id } });
        } else if (p.type === "image") {
          const conv = toInlineData(p.url);
          if ("inlineData" in conv) parts.push({ inlineData: conv.inlineData });
          else parts.push({ fileData: conv.fileData });
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
    }
  }
  flushToolParts();

  // Merge consecutive same-role contents (matches 9router normalizeGeminiContents)
  const normalized: GeminiContent[] = [];
  for (const c of contents) {
    if (!c.parts.length) continue;
    const last = normalized[normalized.length - 1];
    if (last && last.role === c.role) last.parts.push(...c.parts);
    else normalized.push({ role: c.role, parts: [...c.parts] });
  }

  const out: GeminiRequest = {
    contents: normalized,
    ...(systemInstruction ? { systemInstruction } : {}),
  };

  // generationConfig
  const gc: NonNullable<GeminiRequest["generationConfig"]> = {};
  if (req.maxTokens != null) gc.maxOutputTokens = req.maxTokens;
  if (req.temperature !== undefined) gc.temperature = req.temperature;
  if (req.topP !== undefined) gc.topP = req.topP;
  if (req.stop?.length) gc.stopSequences = req.stop;
  if (Object.keys(gc).length) out.generationConfig = gc;

  if (req.tools?.length) {
    out.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          parameters: t.parameters ?? { type: "object", properties: {} },
        })),
      },
    ];
  }

  if (req.extras) Object.assign(out, req.extras);

  // Keep model hint for debugging (not sent to Gemini URL)
  // Caller (executor) uses req.model for URL; wire body may omit it
  return out;
}

// ---------- response stream: Gemini SSE → canonical ----------

const GEMINI_FINISH_MAP: Record<string, FinishReason> = {
  STOP: "stop",
  FINISH_REASON_UNSPECIFIED: "stop",
  MAX_TOKENS: "length",
  SAFETY: "stop",
  RECITATION: "stop",
  BLOCKLIST: "stop",
  PROHIBITED_CONTENT: "stop",
  OTHER: "stop",
  MALFORMED_FUNCTION_CALL: "error",
};

function n(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function extractGeminiUsage(raw: unknown): { input: number; output: number; cached?: number; reasoning?: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const prompt = n(r["promptTokenCount"] ?? r["prompt_token_count"]);
  const candidates = n(r["candidatesTokenCount"] ?? r["candidates_token_count"]);
  const total = n(r["totalTokenCount"] ?? r["total_token_count"]);
  const cached = n(r["cachedContentTokenCount"] ?? r["cached_content_token_count"]);
  const thoughts = n(r["thoughtsTokenCount"] ?? r["thoughts_token_count"]);
  let candOut = candidates;
  if (candOut === 0 && total > 0) {
    candOut = total - prompt - thoughts;
    if (candOut < 0) candOut = 0;
  }
  const output = candOut + thoughts;
  if (prompt === 0 && output === 0 && cached === 0 && thoughts === 0) return null;
  return {
    input: prompt,
    output,
    ...(cached ? { cached } : {}),
    ...(thoughts ? { reasoning: thoughts } : {}),
  };
}

export function geminiStreamToCanonical(): (chunk: unknown) => CanonicalEvent[] {
  let sawToolCall = false;
  return (chunk: unknown): CanonicalEvent[] => {
    const ev: CanonicalEvent[] = [];
    if (chunk == null || typeof chunk !== "object") return ev;

    // Unwrap Antigravity/CLI envelope: { response: { candidates, usageMetadata } }
    const raw = chunk as Record<string, unknown>;
    const envelope = (raw["response"] as Record<string, unknown> | undefined) ?? raw;
    const candidates = (envelope["candidates"] as unknown[] | undefined) ?? (raw["candidates"] as unknown[] | undefined);
    const candidate = (candidates?.[0] as Record<string, unknown> | undefined);
    if (!candidate) {
      // Still surface usage if present without candidates (e.g. final usage-only chunk)
      const usageOnly = (envelope["usageMetadata"] as unknown) ?? raw["usageMetadata"] ?? raw["usage_metadata"];
      const u = extractGeminiUsage(usageOnly);
      if (u) ev.push({ type: "usage", input: u.input, output: u.output, ...(u.cached !== undefined ? { cached: u.cached } : {}), ...(u.reasoning !== undefined ? { reasoning: u.reasoning } : {}) });
      return ev;
    }

    const content = candidate["content"] as { parts?: GeminiPart[] } | undefined;
    const parts = content?.parts ?? [];

    for (const part of parts) {
      const hasThoughtSig = part.thoughtSignature !== undefined || part.thought_signature !== undefined;
      const isThought = part.thought === true;

      // functionCall takes precedence; may coexist with thoughtSignature
      const fc = part.functionCall ?? part.function_call;
      if (fc) {
        sawToolCall = true;
        const id = fc.id ?? `call_${fc.name}`;
        let argsChunk: string | undefined;
        try {
          argsChunk = JSON.stringify(fc.args ?? {});
        } catch {
          argsChunk = "{}";
        }
        ev.push({ type: "tool_call_delta", id, name: fc.name, ...(argsChunk ? { argsChunk } : {}) });
        // If part also has text alongside functionCall with signature, also emit thought/text
        if (hasThoughtSig && typeof part.text === "string" && part.text !== "") {
          if (isThought) ev.push({ type: "reasoning_delta", text: part.text });
          else ev.push({ type: "text_delta", text: part.text });
        }
        continue;
      }

      if (hasThoughtSig) {
        if (typeof part.text === "string" && part.text !== "") {
          if (isThought) ev.push({ type: "reasoning_delta", text: part.text });
          else ev.push({ type: "text_delta", text: part.text });
        }
        continue;
      }

      if (typeof part.text === "string" && part.text !== "") {
        if (isThought) ev.push({ type: "reasoning_delta", text: part.text });
        else ev.push({ type: "text_delta", text: part.text });
      }

      const inline = part.inlineData ?? part.inline_data;
      if (inline?.data) {
        // Images are not streamed as deltas in canonical today; surface as text placeholder is not ideal.
        // We ignore inlineData deltas for streaming; non-stream collector will handle images.
      }
    }

    const usageMeta = (envelope["usageMetadata"] as unknown) ?? raw["usageMetadata"] ?? raw["usage_metadata"] ?? candidate["usageMetadata"] ?? candidate["usage_metadata"];
    const usage = extractGeminiUsage(usageMeta);
    if (usage) {
      ev.push({ type: "usage", input: usage.input, output: usage.output, ...(usage.cached !== undefined ? { cached: usage.cached } : {}), ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}) });
    }

    const frRaw = candidate["finishReason"] ?? candidate["finish_reason"] ?? envelope["finishReason"];
    if (typeof frRaw === "string" && frRaw.length) {
      const upper = frRaw.toUpperCase();
      let finish: FinishReason = GEMINI_FINISH_MAP[upper] ?? "stop";
      if (sawToolCall && finish === "stop") finish = "tool_calls";
      ev.push({ type: "done", finish });
    }

    return ev;
  };
}

// ---------- response: canonical → Gemini SSE (server-side encoding, if needed) ----------

export interface GeminiStreamEncoder {
  encode(ev: CanonicalEvent): string[]; // JSON payloads for data: lines
  close(): string[];
}

export function geminiEncoder(_modelTag: string, _idTag: string): GeminiStreamEncoder {
  let sentDone = false;
  let pendingUsage: { input: number; output: number; cached?: number; reasoning?: number } | null = null;
  let toolIndex = 0;
  return {
    encode(ev) {
      switch (ev.type) {
        case "text_delta": {
          return [
            JSON.stringify({
              candidates: [{ content: { role: "model", parts: [{ text: ev.text }] } }],
            }),
          ];
        }
        case "reasoning_delta": {
          return [
            JSON.stringify({
              candidates: [{ content: { role: "model", parts: [{ text: ev.text, thought: true }] } }],
            }),
          ];
        }
        case "reasoning_signature":
          return [];
        case "tool_call_delta": {
          let args: Record<string, unknown> = {};
          if (ev.argsChunk) {
            try {
              args = JSON.parse(ev.argsChunk) as Record<string, unknown>;
            } catch {
              args = {};
            }
          }
          const name = ev.name ?? `tool_${toolIndex++}`;
          const id = ev.id ?? `call_${name}`;
          return [
            JSON.stringify({
              candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args, id } }] } }],
            }),
          ];
        }
        case "usage": {
          pendingUsage = { input: ev.input, output: ev.output, ...(ev.cached !== undefined ? { cached: ev.cached } : {}), ...(ev.reasoning !== undefined ? { reasoning: ev.reasoning } : {}) };
          return [];
        }
        case "done": {
          sentDone = true;
          const reason =
            ev.finish === "length" ? "MAX_TOKENS" : ev.finish === "tool_calls" ? "STOP" : ev.finish === "error" ? "OTHER" : "STOP";
          const usageMetadata = pendingUsage
            ? {
                promptTokenCount: pendingUsage.input,
                candidatesTokenCount: pendingUsage.output - (pendingUsage.reasoning ?? 0),
                totalTokenCount: pendingUsage.input + pendingUsage.output,
                ...(pendingUsage.cached ? { cachedContentTokenCount: pendingUsage.cached } : {}),
                ...(pendingUsage.reasoning ? { thoughtsTokenCount: pendingUsage.reasoning } : {}),
              }
            : undefined;
          return [
            JSON.stringify({
              candidates: [{ finishReason: reason, content: { role: "model", parts: [] } }],
              ...(usageMetadata ? { usageMetadata } : {}),
            }),
          ];
        }
        case "error":
          return [JSON.stringify({ error: { message: ev.message, code: ev.status } })];
      }
    },
    close() {
      if (sentDone) return [];
      return [
        JSON.stringify({
          candidates: [{ finishReason: "STOP", content: { role: "model", parts: [] } }],
        }),
      ];
    },
  };
}

// ---------- non-stream aggregate: canonical → Gemini JSON ----------

export async function collectGemini(modelTag: string, events: AsyncIterable<CanonicalEvent>): Promise<unknown> {
  let text = "";
  let reasoning = "";
  const toolCalls: Array<{ name: string; args: Record<string, unknown>; id: string }> = [];
  let usage: { input: number; output: number; cached?: number; reasoning?: number } | null = null;
  let finish: FinishReason = "stop";
  let sawToolCall = false;

  for await (const ev of events) {
    switch (ev.type) {
      case "text_delta":
        text += ev.text;
        break;
      case "reasoning_delta":
        reasoning += ev.text;
        break;
      case "reasoning_signature":
        break;
      case "tool_call_delta": {
        sawToolCall = true;
        if (ev.name !== undefined || ev.id !== undefined) {
          let args: Record<string, unknown> = {};
          if (ev.argsChunk) {
            try {
              args = JSON.parse(ev.argsChunk) as Record<string, unknown>;
            } catch {
              args = {};
            }
          }
          toolCalls.push({ name: ev.name ?? "", id: ev.id ?? "", args });
        } else if (ev.argsChunk) {
          const last = toolCalls[toolCalls.length - 1];
          if (last) {
            try {
              const extra = JSON.parse(ev.argsChunk) as Record<string, unknown>;
              last.args = { ...last.args, ...extra };
            } catch {
              // ignore
            }
          }
        }
        break;
      }
      case "usage":
        usage = { input: ev.input, output: ev.output, ...(ev.cached !== undefined ? { cached: ev.cached } : {}), ...(ev.reasoning !== undefined ? { reasoning: ev.reasoning } : {}) };
        break;
      case "done":
        if (ev.finish != null) finish = ev.finish;
        break;
      case "error":
        throw new Error(ev.message);
    }
  }

  if (sawToolCall && finish === "stop") finish = "tool_calls";

  const parts: GeminiPart[] = [];
  if (reasoning) parts.push({ thought: true, text: reasoning });
  if (text) parts.push({ text });
  for (const tc of toolCalls) {
    parts.push({ functionCall: { name: tc.name, args: tc.args, id: tc.id } });
  }

  const finishReason = finish === "length" ? "MAX_TOKENS" : finish === "error" ? "OTHER" : "STOP";

  return {
    candidates: [
      {
        content: { role: "model", parts: parts.length ? parts : [{ text: "" }] },
        finishReason,
      },
    ],
    modelVersion: modelTag,
    ...(usage
      ? {
          usageMetadata: {
            promptTokenCount: usage.input,
            candidatesTokenCount: usage.output - (usage.reasoning ?? 0),
            totalTokenCount: usage.input + usage.output,
            ...(usage.cached ? { cachedContentTokenCount: usage.cached } : {}),
            ...(usage.reasoning ? { thoughtsTokenCount: usage.reasoning } : {}),
          },
        }
      : {}),
  };
}

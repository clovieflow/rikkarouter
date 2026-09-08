// Anthropic Messages API ⇄ canonical (request, streaming, encoder, collector).
// Pattern informed by 9router open-sse/translator (MIT); rewritten single-source.
import type {
  CanonicalEvent,
  CanonicalMessage,
  CanonicalRequest,
  ContentPart,
  FinishReason,
  ToolSpec,
} from "../types.ts";

// ---------- wire types (subset we consume; extras land in `unknown` passthrough) ----------

export interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  system?: string | Array<{ type: string; text?: string }>;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
  }>;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  thinking?: { type: string; budget_tokens?: number };
  [k: string]: unknown;
}

const KNOWN_BODY_KEYS: Record<string, true> = {
  model: true, messages: true, system: true, tools: true, tool_choice: true, stream: true,
  max_tokens: true, temperature: true, top_p: true, stop_sequences: true, thinking: true,
};

function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const blk = b as { type?: string; text?: string };
      return blk.type === "text" && typeof blk.text === "string" ? blk.text : "";
    })
    .join("");
}

function imageToUrl(source: unknown): string {
  const s = source as { type?: string; media_type?: string; data?: string; url?: string };
  if (s?.type === "base64" && s.media_type && s.data) return `data:${s.media_type};base64,${s.data}`;
  if (s?.type === "url" && s.url) return s.url;
  return "";
}

// ---------- request: Anthropic → canonical ----------

export function anthropicToCanonical(body: AnthropicRequest): CanonicalRequest {
  const messages: CanonicalMessage[] = [];

  const systemBlocks = typeof body.system === "string"
    ? (body.system ? [{ type: "text", text: body.system }] : [])
    : Array.isArray(body.system) ? body.system : [];
  const systemText = systemBlocks.filter((b) => b.type === "text" && b.text).map((b) => b.text as string).join("\n\n");
  if (systemText) messages.push({ role: "system", content: [{ type: "text", text: systemText }] });

  for (const m of body.messages) {
    const parts: ContentPart[] = [];
    let reasoning: string | undefined;
    let reasoningSig: string | undefined;
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
    for (const b of blocks) {
      switch (b.type) {
        case "text":
          if (typeof b.text === "string" && b.text) parts.push({ type: "text", text: b.text });
          break;
        case "image": {
          const url = imageToUrl(b.source);
          if (url) parts.push({ type: "image", url });
          break;
        }
        case "tool_use":
          parts.push({ type: "tool_call", id: String(b.id ?? ""), name: String(b.name ?? ""), args: JSON.stringify(b.input ?? {}) });
          break;
        case "tool_result": {
          const isErr = b.is_error === true;
          let text = flattenText(b.content);
          if (!text && typeof b.content === "string") text = b.content;
          parts.push({ type: "tool_result", toolCallId: String(b.tool_use_id ?? ""), content: isErr ? `[error] ${text}` : text });
          break;
        }
        case "thinking":
          reasoning = (reasoning ?? "") + String(b.thinking ?? "");
          if (typeof b.signature === "string" && b.signature) reasoningSig = b.signature;
          break;
        case "redacted_thinking":
          break; // not replayable content — drop
        case "document":
          parts.push({ type: "text", text: "[unsupported document content]" });
          break;
        default:
          break;
      }
    }
    const msg: CanonicalMessage = { role: m.role, content: parts };
    if (reasoning) msg.reasoning = reasoning;
    if (reasoningSig) msg.reasoningSignature = reasoningSig;
    messages.push(msg);
  }

  const tools: ToolSpec[] | undefined = body.tools?.length
    ? body.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.input_schema ?? {} }))
    : undefined;

  const extras: Record<string, unknown> = {};
  for (const k of Object.keys(body)) if (!(k in KNOWN_BODY_KEYS)) extras[k] = (body as Record<string, unknown>)[k];
  if (body.tool_choice !== undefined) extras.tool_choice = normalizeToolChoiceToOpenAI(body.tool_choice);

  const req: CanonicalRequest = {
    model: body.model,
    messages,
    stream: body.stream === true,
    ...(tools?.length ? { tools } : {}),
    ...(Object.keys(extras).length ? { extras } : {}),
    ...(body.max_tokens != null ? { maxTokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
    ...(body.stop_sequences?.length ? { stop: body.stop_sequences } : {}),
  };
  if (body.thinking?.type === "enabled") {
    req.thinking = { type: "enabled", ...(body.thinking.budget_tokens != null ? { budgetTokens: body.thinking.budget_tokens } : {}) };
  }
  return req;
}

/** anthropic tool_choice → canonical/openai-ish shape kept for upstream replay. */
function normalizeToolChoiceToOpenAI(tc: unknown): unknown {
  if (tc && typeof tc === "object") {
    const t = tc as { type?: string };
    if (t.type === "any") return "required";
    if (t.type === "tool" && "name" in t) return { type: "function", function: { name: (t as { name: string }).name } };
  }
  return tc;
}

// ---------- request: canonical → Anthropic wire ----------

export function canonicalToAnthropic(req: CanonicalRequest): AnthropicRequest {
  let system: string | undefined;
  const messages: AnthropicRequest["messages"] = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      const text = m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n\n");
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }
    const blocks: Array<Record<string, unknown>> = [];
    const toolResults: Record<string, unknown>[] = [];
    for (const p of m.content) {
      if (p.type === "text" && p.text) blocks.push({ type: "text", text: p.text });
      else if (p.type === "image") blocks.push({ type: "image", source: imageSourceFromUrl(p.url) });
      else if (p.type === "tool_call") blocks.push({ type: "tool_use", id: p.id, name: p.name, input: safeParse(p.args) });
      else if (p.type === "tool_result") toolResults.push({ type: "tool_result", tool_use_id: p.toolCallId, content: p.content });
    }
    // tool_results must live in user messages; text/tool_use mixings keep canonical role
    if (toolResults.length) {
      messages.push({ role: "user", content: [...toolResults, ...blocks.filter((b) => b.type !== "tool_use" && b.type !== "thinking")] });
    }
    if (m.role === "assistant" && (blocks.length || m.reasoning)) {
      const asst: Array<Record<string, unknown>> = [];
      if (m.reasoning) asst.push({ type: "thinking", thinking: m.reasoning, ...(m.reasoningSignature ? { signature: m.reasoningSignature } : {}) });
      asst.push(...blocks);
      if (asst.length) messages.push({ role: "assistant", content: asst });
    } else if (m.role === "user" && blocks.length && !toolResults.length) {
      messages.push({ role: "user", content: blocks });
    }
  }

  const wire: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: capThinking(req.maxTokens ?? 8192, req.thinking),
    stream: req.stream,
  };
  if (system) wire.system = system;
  if (req.tools?.length) {
    wire.tools = req.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: t.parameters }));
  }
  if (req.temperature !== undefined) wire.temperature = req.temperature;
  if (req.topP !== undefined) wire.top_p = req.topP;
  if (req.stop?.length) wire.stop_sequences = req.stop;
  if (req.thinking?.type === "enabled") {
    wire.thinking = { type: "enabled", budget_tokens: Math.min(req.thinking.budgetTokens ?? 1024, (wire.max_tokens as number) - 1024) };
    delete wire.temperature; // anthropic rejects temperature with thinking
  }
  if (req.extras) {
    for (const [k, v] of Object.entries(req.extras)) {
      if (k === "tool_choice") wire.tool_choice = denormalizeToolChoiceFromOpenAI(v);
      else wire[k] = v;
    }
  }
  return wire as unknown as AnthropicRequest;
}

function capThinking(max: number, thinking: CanonicalRequest["thinking"]): number {
  if (thinking?.type === "enabled") return Math.max(max, (thinking.budgetTokens ?? 1024) + 1024);
  return max;
}

function denormalizeToolChoiceFromOpenAI(tc: unknown): unknown {
  if (tc === "required") return { type: "any" };
  if (tc && typeof tc === "object" && (tc as { type?: string }).type === "function") {
    return { type: "tool", name: (tc as { function?: { name?: string } }).function?.name ?? "" };
  }
  return tc;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

function imageSourceFromUrl(url: string): Record<string, unknown> {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (m) return { type: "base64", media_type: m[1], data: m[2] };
  return { type: "url", url };
}

// ---------- response stream: Anthropic SSE → canonical ----------

const CLAUDE_STOP: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
};

interface BlockState {
  type?: string;
}

export function anthropicStreamToCanonical(): (event: { event?: string; data: string }) => CanonicalEvent[] {
  let stopReason: string | null = null;
  const blocks: BlockState[] = [];
  return ({ event, data }) => {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data);
    } catch {
      return [];
    }
    const ev = (json.type as string) || event || "";
    switch (ev) {
      case "message_start": {
        const msg = json.message as { usage?: Record<string, number> } | undefined;
        const u = msg?.usage;
        if (u) {
          return [{ type: "usage", input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, ...(u.cache_read_input_tokens ? { cached: u.cache_read_input_tokens } : {}), ...(u.cache_creation_input_tokens ? { reasoning: 0 } : {}) }];
        }
        return [];
      }
      case "content_block_start": {
        const idx = json.index as number;
        const block = json.content_block as { type?: string; id?: string; name?: string };
        blocks[idx] = { ...(block.type ? { type: block.type } : {}) };
        if (block.type === "tool_use") {
          return [{ type: "tool_call_delta", id: block.id ?? "", name: block.name ?? "" }];
        }
        return [];
      }
      case "content_block_delta": {
        const d = json.delta as { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string };
        if (d.type === "text_delta" && d.text) return [{ type: "text_delta", text: d.text }];
        if (d.type === "thinking_delta" && d.thinking) return [{ type: "reasoning_delta", text: d.thinking }];
        if (d.type === "signature_delta" && d.signature) return [{ type: "reasoning_signature", text: d.signature }];
        if (d.type === "input_json_delta" && d.partial_json) return [{ type: "tool_call_delta", argsChunk: d.partial_json }];
        return [];
      }
      case "message_delta": {
        const d = json.delta as { stop_reason?: string } | undefined;
        const u = json.usage as { output_tokens?: number; cache_read_input_tokens?: number } | undefined;
        if (d?.stop_reason) stopReason = d.stop_reason;
        if (u?.output_tokens != null) {
          const out: CanonicalEvent[] = [{ type: "usage", input: 0, output: u.output_tokens, ...(u.cache_read_input_tokens ? { cached: u.cache_read_input_tokens } : {}) }];
          return out;
        }
        return [];
      }
      case "message_stop":
        return [{ type: "done", finish: (stopReason && CLAUDE_STOP[stopReason]) || "stop" }];
      case "error": {
        const e = json.error as { type?: string; message?: string } | undefined;
        return [{ type: "error", status: 500, message: e?.message ?? "anthropic stream error" }];
      }
      default:
        return []; // ping, content_block_stop
    }
  };
}

/** message_delta usage merging: gateway note — a second `usage` event with input 0 only updates output. */
export function mergeUsage(prev: { input: number; output: number; cached: number }, next: CanonicalEvent & { type: "usage" }): { input: number; output: number; cached: number } {
  return {
    input: next.input || prev.input,
    output: next.output || prev.output,
    cached: next.cached ?? prev.cached,
  };
}

// ---------- response: canonical → Anthropic SSE ----------

export interface ClaudeStreamEncoder {
  begin(): string[]; // full SSE frames ("event: x\ndata: {...}\n\n")
  encode(ev: CanonicalEvent): string[];
  close(): string[];
}

export function claudeEncoder(modelTag: string, idTag: string): ClaudeStreamEncoder {
  let started = false;
  let index = -1;
  let openBlock: "text" | "thinking" | "tool" | null = null;
  let usage = { input: 0, output: 0 };
  let done = false;
  let toolStarted = false;

  const frame = (event: string, data: Record<string, unknown>) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
  const ensureStart = (out: string[]) => {
    if (started) return;
    started = true;
    out.push(frame("message_start", { message: { id: idTag, type: "message", role: "assistant", model: modelTag, content: [], usage: { input_tokens: usage.input, output_tokens: 0 } } }));
  };
  const closeBlock = (out: string[]) => {
    if (openBlock === null) return;
    out.push(frame("content_block_stop", { index }));
    openBlock = null;
  };
  const openBlockAs = (out: string[], kind: "text" | "thinking" | "tool", block: Record<string, unknown>) => {
    if (openBlock !== kind) {
      closeBlock(out);
      index += 1;
      openBlock = kind;
      out.push(frame("content_block_start", { index, content_block: block }));
    }
  };

  return {
    begin() {
      const out: string[] = [];
      ensureStart(out);
      return out;
    },
    encode(ev) {
      const out: string[] = [];
      switch (ev.type) {
        case "text_delta":
          ensureStart(out);
          openBlockAs(out, "text", { type: "text", text: "" });
          out.push(frame("content_block_delta", { index, delta: { type: "text_delta", text: ev.text } }));
          break;
        case "reasoning_delta":
          ensureStart(out);
          openBlockAs(out, "thinking", { type: "thinking", thinking: "" });
          out.push(frame("content_block_delta", { index, delta: { type: "thinking_delta", thinking: ev.text } }));
          break;
        case "reasoning_signature":
          if (openBlock === "thinking") out.push(frame("content_block_delta", { index, delta: { type: "signature_delta", signature: ev.text } }));
          break;
        case "tool_call_delta":
          ensureStart(out);
          if (ev.id !== undefined || ev.name !== undefined) {
            closeBlock(out);
            index += 1;
            openBlock = "tool";
            toolStarted = true;
            out.push(frame("content_block_start", { index, content_block: { type: "tool_use", id: ev.id ?? `toolu_${index}`, name: ev.name ?? "" } }));
            if (ev.argsChunk) out.push(frame("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: ev.argsChunk } }));
          } else if (ev.argsChunk && openBlock === "tool") {
            out.push(frame("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: ev.argsChunk } }));
          }
          break;
        case "usage":
          usage = { input: ev.input || usage.input, output: ev.output || usage.output };
          break;
        case "done":
          done = true;
          ensureStart(out);
          closeBlock(out);
          out.push(frame("message_delta", { delta: { stop_reason: ev.finish === "tool_calls" ? "tool_use" : ev.finish === "length" ? "max_tokens" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output } }));
          out.push(frame("message_stop", {}));
          break;
        case "error":
          done = true;
          ensureStart(out);
          closeBlock(out);
          out.push(frame("error", { error: { type: "overloaded_error", message: ev.message } }));
          break;
      }
      return out;
    },
    close() {
      if (done) return [];
      const out: string[] = [];
      ensureStart(out);
      closeBlock(out);
      out.push(frame("message_delta", { delta: { stop_reason: toolStarted ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output } }));
      out.push(frame("message_stop", {}));
      return out;
    },
  };
}

// ---------- non-stream aggregate: canonical → Anthropic message JSON ----------

export async function collectAnthropic(modelTag: string, events: AsyncIterable<CanonicalEvent>) {
  let text = "";
  let thinking = "";
  let signature: string | undefined;
  const tools: { id: string; name: string; args: string }[] = [];
  let usage = { input: 0, output: 0 };
  let finish: FinishReason = "stop";
  for await (const ev of events) {
    switch (ev.type) {
      case "text_delta":
        text += ev.text;
        break;
      case "reasoning_delta":
        thinking += ev.text;
        break;
      case "reasoning_signature":
        signature = (signature ?? "") + ev.text;
        break;
      case "tool_call_delta":
        if (ev.id !== undefined || ev.name !== undefined) tools.push({ id: ev.id ?? "", name: ev.name ?? "", args: ev.argsChunk ?? "" });
        else {
          const cur = tools[tools.length - 1];
          if (cur && ev.argsChunk) cur.args += ev.argsChunk;
        }
        break;
      case "usage":
        usage = { input: ev.input || usage.input, output: ev.output || usage.output };
        break;
      case "done":
        finish = ev.finish;
        break;
      case "error":
        throw new Error(ev.message);
    }
  }
  const content: Array<Record<string, unknown>> = [];
  if (thinking) content.push({ type: "thinking", thinking, ...(signature ? { signature } : {}) });
  if (text) content.push({ type: "text", text });
  for (const t of tools) content.push({ type: "tool_use", id: t.id, name: t.name, input: safeParse(t.args) });
  return {
    id: `msg_${modelTag.replace(/[^a-z0-9]/gi, "").slice(0, 12)}_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: modelTag,
    content,
    stop_reason: finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  };
}

// ---------- token counting heuristic (for /v1/messages/count_tokens) ----------

export function estimateTokens(body: AnthropicRequest): number {
  let chars = 0;
  const feed = (v: unknown): void => {
    if (typeof v === "string") chars += v.length;
    else if (Array.isArray(v)) for (const x of v) feed(x);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "text" || k === "content" || k === "thinking") feed(x);
        else if (k === "input" || k === "input_schema") chars += JSON.stringify(x).length * 0.6;
      }
    }
  };
  feed(body.system);
  for (const m of body.messages) feed(m.content);
  for (const t of body.tools ?? []) chars += JSON.stringify(t).length * 0.6;
  return Math.max(1, Math.ceil(chars / 4));
}

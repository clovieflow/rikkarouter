// derived from 9router (MIT) — OpenAI Responses API translator; see NOTICE
// Pattern informed by 9router open-sse/translator (MIT); rewritten for single-source canonical.
import type {
  CanonicalEvent,
  CanonicalMessage,
  CanonicalRequest,
  ContentPart,
  FinishReason,
} from "../types.ts";

// ---------- wire types ----------
export interface ResponsesRequest {
  model: string;
  input?: string | Array<Record<string, unknown>>;
  instructions?: string;
  tools?: Array<{
    type: string;
    name: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean;
  }>;
  tool_choice?: unknown;
  stream?: boolean;
  max_output_tokens?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning?: unknown;
  store?: boolean;
  include?: unknown;
  prompt_cache_key?: unknown;
  service_tier?: unknown;
  [k: string]: unknown;
}

export interface ResponsesResponse {
  id?: string;
  object?: string;
  created_at?: number;
  model?: string;
  output?: Array<Record<string, unknown>>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  status?: string;
  error?: unknown;
  [k: string]: unknown;
}

const KNOWN_BODY_KEYS: Record<string, true> = {
  model: true,
  input: true,
  instructions: true,
  tools: true,
  tool_choice: true,
  stream: true,
  max_output_tokens: true,
  max_tokens: true,
  max_completion_tokens: true,
  temperature: true,
  top_p: true,
  reasoning: true,
  store: true,
  include: true,
  prompt_cache_key: true,
  service_tier: true,
};

// ---------- helpers ----------

function normalizeInput(input: ResponsesRequest["input"]): Array<Record<string, unknown>> {
  if (typeof input === "string") {
    const text = input.trim() === "" ? "..." : input;
    return [{ type: "message", role: "user", content: [{ type: "input_text", text }] }];
  }
  if (Array.isArray(input)) {
    if (input.length === 0) {
      return [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }
    return input as Array<Record<string, unknown>>;
  }
  return [];
}

// ---------- request: Responses → canonical ----------
export function responsesToCanonical(body: ResponsesRequest): CanonicalRequest {
  const messages: CanonicalMessage[] = [];

  if (typeof body.instructions === "string" && body.instructions.trim() !== "") {
    messages.push({ role: "system", content: [{ type: "text", text: body.instructions }] });
  }

  const items = normalizeInput(body.input);

  let pendingAssistant: CanonicalMessage | null = null;
  const flushAssistant = () => {
    if (pendingAssistant) {
      messages.push(pendingAssistant);
      pendingAssistant = null;
    }
  };

  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    const type = (item.type as string | undefined) ?? (item.role ? "message" : undefined);

    if (type === "message") {
      flushAssistant();
      const roleRaw = (item.role as string | undefined) ?? "user";
      const role: CanonicalMessage["role"] =
        roleRaw === "developer" || roleRaw === "system"
          ? "system"
          : roleRaw === "assistant"
            ? "assistant"
            : roleRaw === "tool"
              ? "tool"
              : "user";

      const contentRaw = item.content;
      const parts: ContentPart[] = [];

      if (Array.isArray(contentRaw)) {
        for (const c of contentRaw as Array<Record<string, unknown>>) {
          const ct = c.type as string | undefined;
          if (ct === "input_text" || ct === "output_text" || ct === "text") {
            const t = c.text as string | undefined;
            if (typeof t === "string") parts.push({ type: "text", text: t });
          } else if (ct === "input_image") {
            const url =
              (c.image_url as string | undefined) ??
              (c.url as string | undefined) ??
              (c.file_id as string | undefined) ??
              "";
            if (url) parts.push({ type: "image", url });
            else if (typeof c.image_url === "object" && c.image_url !== null) {
              const nested = (c.image_url as { url?: string }).url;
              if (nested) parts.push({ type: "image", url: nested });
            }
          } else if (ct === "image_url") {
            const nested = (c as { image_url?: { url?: string }; url?: string }).image_url?.url ?? (c as { url?: string }).url;
            if (nested) parts.push({ type: "image", url: nested });
          } else if (typeof c.text === "string") {
            parts.push({ type: "text", text: c.text });
          }
        }
      } else if (typeof contentRaw === "string" && contentRaw) {
        parts.push({ type: "text", text: contentRaw });
      }

      messages.push({ role, content: parts });
      continue;
    }

    if (type === "function_call" || type === "custom_tool_call") {
      const callId = (item.call_id as string | undefined) ?? (item.id as string | undefined) ?? "";
      const name = (item.name as string | undefined) ?? "";
      if (!name || name.trim() === "") continue;
      const rawArgs = (item.arguments as unknown) ?? (item as { input?: unknown }).input ?? "{}";
      const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
      if (!pendingAssistant) pendingAssistant = { role: "assistant", content: [] };
      pendingAssistant.content.push({ type: "tool_call", id: callId, name, args });
      continue;
    }

    if (type === "function_call_output" || type === "custom_tool_call_output") {
      flushAssistant();
      const callId = (item.call_id as string | undefined) ?? (item.id as string | undefined) ?? "";
      const outputRaw = item.output ?? (item as { input?: unknown }).input;
      const text = typeof outputRaw === "string" ? outputRaw : outputRaw != null ? JSON.stringify(outputRaw) : "";
      messages.push({ role: "tool", content: [{ type: "tool_result", toolCallId: callId, content: text }] });
      continue;
    }

    if (type === "reasoning") {
      // ignore for MVP
      continue;
    }
  }

  flushAssistant();

  const tools = body.tools?.map((t) => ({
    name: t.name ?? "",
    ...(t.description ? { description: t.description } : {}),
    parameters: t.parameters ?? { type: "object", properties: {} },
  }));

  const extras: Record<string, unknown> = {};
  for (const k of Object.keys(body)) if (!(k in KNOWN_BODY_KEYS)) extras[k] = (body as Record<string, unknown>)[k];
  if (body.tool_choice !== undefined) extras.tool_choice = body.tool_choice;

  // max_output_tokens ↔ maxTokens
  const maxTok = body.max_output_tokens ?? body.max_tokens ?? body.max_completion_tokens;

  return {
    model: body.model,
    messages,
    ...(tools?.length ? { tools } : {}),
    ...(Object.keys(extras).length ? { extras } : {}),
    stream: body.stream === true,
    ...(maxTok != null ? { maxTokens: maxTok as number } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature as number } : {}),
    ...(body.top_p !== undefined ? { topP: body.top_p as number } : {}),
  };
}

// ---------- request: canonical → Responses ----------
export function canonicalToResponses(req: CanonicalRequest): ResponsesRequest {
  const input: Array<Record<string, unknown>> = [];
  let instructions: string | undefined;

  for (const m of req.messages) {
    const textParts = m.content.filter((p) => p.type === "text") as Array<Extract<ContentPart, { type: "text" }>>;
    const text = textParts.map((p) => p.text).join("");
    const imageParts = m.content.filter((p) => p.type === "image") as Array<Extract<ContentPart, { type: "image" }>>;
    const toolCalls = m.content.filter((p) => p.type === "tool_call") as Array<Extract<ContentPart, { type: "tool_call" }>>;
    const toolResults = m.content.filter((p) => p.type === "tool_result") as Array<Extract<ContentPart, { type: "tool_result" }>>;

    if (m.role === "system") {
      if (instructions === undefined) {
        instructions = text || imageParts.map((i) => i.url).join("\n") || "";
      } else {
        // subsequent system messages become developer messages in input
        const content: Array<Record<string, unknown>> = [];
        if (text) content.push({ type: "input_text", text });
        for (const im of imageParts) content.push({ type: "input_image", image_url: im.url });
        if (content.length) input.push({ type: "message", role: "system", content });
      }
      continue;
    }

    if (toolResults.length) {
      for (const tr of toolResults) {
        input.push({ type: "function_call_output", call_id: tr.toolCallId, output: tr.content });
      }
      continue;
    }

    if (m.role === "assistant" && toolCalls.length) {
      if (text || imageParts.length) {
        const content: Array<Record<string, unknown>> = [];
        if (text) content.push({ type: "output_text", text });
        for (const im of imageParts) content.push({ type: "input_image", image_url: im.url });
        if (content.length) input.push({ type: "message", role: "assistant", content });
      }
      for (const tc of toolCalls) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: tc.args });
      }
      continue;
    }

    // user or assistant without tool calls
    const content: Array<Record<string, unknown>> = [];
    if (text) content.push({ type: m.role === "assistant" ? "output_text" : "input_text", text });
    for (const im of imageParts) content.push({ type: "input_image", image_url: im.url });
    if (content.length === 0) continue;
    input.push({ type: "message", role: m.role, content });
  }

  if (input.length === 0) {
    input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] });
  }

  let toolsWire: ResponsesRequest["tools"] | undefined;
  if (req.tools?.length) {
    toolsWire = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: (t.parameters ?? { type: "object", properties: {} }) as unknown as Record<string, unknown>,
    }));
  }

  const out: ResponsesRequest = {
    model: req.model,
    input: input as ResponsesRequest["input"],
    ...(instructions !== undefined && instructions !== "" ? { instructions } : {}),
    ...(toolsWire ? { tools: toolsWire } : {}),
    stream: req.stream,
  } as ResponsesRequest;

  if (req.maxTokens != null) out.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.topP !== undefined) out.top_p = req.topP;
  if (req.stop?.length) out.include = undefined; // no direct mapping; keep in extras instead
  if (req.extras) Object.assign(out, req.extras);
  // ensure stop is preserved via extras if not mapped
  if (req.stop?.length && !("stop" in out)) (out as Record<string, unknown>).stop = req.stop;

  return out;
}

// ---------- response: Responses SSE → canonical ----------
export function responsesStreamToCanonical(): (chunk: unknown) => CanonicalEvent[] {
  let currentToolId = "";
  let currentToolName = "";
  let sawTool = false;

  return (chunk: unknown): CanonicalEvent[] => {
    const ev: CanonicalEvent[] = [];
    let eventName: string | undefined;
    let data: Record<string, unknown> | null = null;

    if (chunk && typeof chunk === "object" && "data" in (chunk as Record<string, unknown>)) {
      const m = chunk as { event?: string; data: string };
      if (typeof m.data === "string") {
        eventName = m.event;
        try {
          data = JSON.parse(m.data) as Record<string, unknown>;
        } catch {
          return [];
        }
        if (!eventName && typeof data.type === "string") eventName = data.type;
        if (!eventName && typeof data.event === "string") eventName = data.event as string;
      } else {
        // already parsed object inside data
        data = m.data as unknown as Record<string, unknown>;
        eventName = m.event ?? (data.type as string | undefined) ?? (data.event as string | undefined);
      }
    } else if (chunk && typeof chunk === "object") {
      data = chunk as Record<string, unknown>;
      eventName = (data.type as string | undefined) ?? (data.event as string | undefined);
    } else {
      return [];
    }

    if (!data) return [];
    // normalize: data may be wrapper with nested response/usage/item
    switch (eventName) {
      case "response.output_text.delta": {
        const delta = (data.delta as string | undefined) ?? ((data as { data?: { delta?: string } }).data?.delta as string | undefined) ?? "";
        if (typeof delta === "string" && delta) ev.push({ type: "text_delta", text: delta });
        break;
      }
      case "response.output_item.added": {
        const item = (data.item as Record<string, unknown> | undefined) ?? ((data as { data?: { item?: Record<string, unknown> } }).data?.item as Record<string, unknown> | undefined);
        if (item && (item.type === "function_call" || item.type === "custom_tool_call")) {
          currentToolId = (item.call_id as string | undefined) ?? (item.id as string | undefined) ?? "";
          currentToolName = (item.name as string | undefined) ?? "";
          if (currentToolName || currentToolId) {
            sawTool = true;
            ev.push({ type: "tool_call_delta", id: currentToolId, name: currentToolName });
          }
        }
        break;
      }
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta": {
        const delta = (data.delta as string | undefined) ?? ((data as { data?: { delta?: string } }).data?.delta as string | undefined) ?? "";
        if (typeof delta === "string" && delta) {
          sawTool = true;
          // if we haven't yet emitted id/name via added, include what we have; otherwise just argsChunk
          if (currentToolId || currentToolName) {
            // Emit args chunk alone if id/name already sent; but include id for correlation on first chunk if needed
            // We send argsChunk only to avoid duplicate name emission; test expects argsChunk
            // Include id if we have it to help collector correlate
            ev.push({ type: "tool_call_delta", ...(currentToolId ? { id: currentToolId } : {}), ...(currentToolName ? { name: currentToolName } : {}), argsChunk: delta });
            // clear name after first args delta to avoid repeating
            currentToolName = "";
          } else {
            ev.push({ type: "tool_call_delta", argsChunk: delta });
          }
        }
        break;
      }
      case "response.output_item.done": {
        // tool call finished, reset for next
        if (currentToolId || sawTool) {
          // keep sawTool true, just reset current ids
          currentToolId = "";
          currentToolName = "";
        }
        break;
      }
      case "response.completed":
      case "response.done": {
        const resp = (data.response as Record<string, unknown> | undefined) ?? data;
        const usage = (resp.usage as Record<string, unknown> | undefined) ?? (data.usage as Record<string, unknown> | undefined);
        if (usage && typeof usage === "object") {
          const input = (usage.input_tokens as number | undefined) ?? (usage.prompt_tokens as number | undefined) ?? 0;
          const output = (usage.output_tokens as number | undefined) ?? (usage.completion_tokens as number | undefined) ?? 0;
          const cached = (usage.input_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens;
          const reasoning = (usage.output_tokens_details as { reasoning_tokens?: number } | undefined)?.reasoning_tokens;
          ev.push({
            type: "usage",
            input,
            output,
            ...(cached ? { cached } : {}),
            ...(reasoning ? { reasoning } : {}),
          });
        }
        const finish: FinishReason = sawTool ? "tool_calls" : "stop";
        ev.push({ type: "done", finish });
        break;
      }
      case "response.failed":
      case "error": {
        const errObj = (data.error as Record<string, unknown> | undefined) ?? (data.response as Record<string, unknown> | undefined)?.error as Record<string, unknown> | undefined ?? data;
        const msg = (errObj.message as string | undefined) ?? JSON.stringify(errObj);
        ev.push({ type: "error", status: 502, message: String(msg), provider: "responses" });
        break;
      }
      case "response.reasoning_summary_text.delta": {
        const delta = (data.delta as string | undefined) ?? "";
        if (delta) ev.push({ type: "reasoning_delta", text: delta });
        break;
      }
      case "response.created":
      case "response.in_progress":
      case "response.output_text.done":
      case "response.content_part.added":
      case "response.content_part.done":
      case "response.output_text.annotation.added":
        break;
      default:
        // tolerate wrapped forms: if data has delta and type is missing but looks like text delta
        if (typeof data.delta === "string" && eventName && eventName.includes("output_text.delta")) {
          ev.push({ type: "text_delta", text: data.delta as string });
        }
        break;
    }
    return ev;
  };
}

// ---------- response: canonical → Responses SSE ----------
export interface ResponsesStreamEncoder {
  encode(ev: CanonicalEvent): string[];
  close(): string[];
}

export function responsesEncoder(responseId: string = `resp_${Date.now()}`, _modelTag?: string): ResponsesStreamEncoder {
  let seq = 0;
  const nextSeq = () => ++seq;
  let usageHeld: CanonicalEvent & { type: "usage" } | null = null;
  let doneSent = false;
  let toolActive = false;
  let toolId = "";
  let toolName = "";

  const frame = (event: string, data: unknown): string => {
    (data as Record<string, unknown>).sequence_number = nextSeq();
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  };

  return {
    encode(ev) {
      switch (ev.type) {
        case "text_delta":
          return [
            frame("response.output_text.delta", {
              type: "response.output_text.delta",
              output_index: 0,
              delta: ev.text,
            }),
          ];
        case "reasoning_delta":
          return [
            frame("response.reasoning_summary_text.delta", {
              type: "response.reasoning_summary_text.delta",
              delta: ev.text,
            }),
          ];
        case "reasoning_signature":
          return [];
        case "tool_call_delta": {
          const out: string[] = [];
          if (ev.name !== undefined || ev.id !== undefined) {
            toolActive = true;
            toolId = ev.id ?? toolId;
            toolName = ev.name ?? toolName;
            out.push(
              frame("response.output_item.added", {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "function_call", call_id: toolId, name: toolName, arguments: "" },
              }),
            );
            if (ev.argsChunk) {
              out.push(
                frame("response.function_call_arguments.delta", {
                  type: "response.function_call_arguments.delta",
                  output_index: 0,
                  delta: ev.argsChunk,
                }),
              );
            }
            // clear name after emitting to avoid dup
            toolName = "";
            return out;
          }
          if (ev.argsChunk) {
            return [
              frame("response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                delta: ev.argsChunk,
              }),
            ];
          }
          return [];
        }
        case "usage":
          usageHeld = ev;
          return [];
        case "done": {
          doneSent = true;
          const usage = usageHeld
            ? {
                input_tokens: usageHeld.input,
                output_tokens: usageHeld.output,
                ...(usageHeld.cached ? { input_tokens_details: { cached_tokens: usageHeld.cached } } : {}),
                ...(usageHeld.reasoning ? { output_tokens_details: { reasoning_tokens: usageHeld.reasoning } } : {}),
              }
            : { input_tokens: 0, output_tokens: 0 };
          return [
            frame("response.completed", {
              type: "response.completed",
              response: {
                id: responseId,
                status: "completed",
                usage,
              },
            }),
          ];
        }
        case "error":
          return [
            frame("response.failed", {
              type: "response.failed",
              response: {
                id: responseId,
                status: "failed",
                error: { message: ev.message, type: "api_error" },
              },
            }),
          ];
      }
    },
    close() {
      if (!doneSent) {
        const usage = usageHeld
          ? {
              input_tokens: usageHeld.input,
              output_tokens: usageHeld.output,
              ...(usageHeld.cached ? { input_tokens_details: { cached_tokens: usageHeld.cached } } : {}),
            }
          : { input_tokens: 0, output_tokens: 0 };
        return [
          frame("response.completed", {
            type: "response.completed",
            response: { id: responseId, status: "completed", usage },
          }),
        ];
      }
      return [];
    },
  };
}

// ---------- non-stream collector: canonical → Responses JSON ----------
export async function collectResponses(
  modelTag: string,
  events: AsyncIterable<CanonicalEvent>,
  responseId?: string,
): Promise<ResponsesResponse> {
  let text = "";
  let reasoning = "";
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let idx = -1;
  let usage: { input: number; output: number; cached?: number; reasoning?: number } | null = null;
  let finish: FinishReason = "stop";

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
        if (ev.id !== undefined || ev.name !== undefined) {
          idx += 1;
          toolCalls.set(idx, { id: ev.id ?? "", name: ev.name ?? "", args: ev.argsChunk ?? "" });
        } else if (ev.argsChunk) {
          const cur = toolCalls.get(Math.max(idx, 0));
          if (cur) cur.args += ev.argsChunk;
          else {
            // no prior tool, create one
            idx = 0;
            toolCalls.set(0, { id: "", name: "", args: ev.argsChunk });
          }
        }
        break;
      }
      case "usage":
        usage = { input: ev.input, output: ev.output, ...(ev.cached ? { cached: ev.cached } : {}), ...(ev.reasoning ? { reasoning: ev.reasoning } : {}) };
        break;
      case "done":
        finish = ev.finish;
        break;
      case "error":
        throw new Error(ev.message);
    }
  }

  const output: Array<Record<string, unknown>> = [];
  if (text) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  }
  if (reasoning) {
    output.push({ type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] });
  }
  for (const tc of toolCalls.values()) {
    output.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: tc.args });
  }
  // if no output at all, ensure at least an empty message
  if (output.length === 0) {
    output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] });
  }

  return {
    id: responseId ?? `resp_${Date.now().toString(36)}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: modelTag,
    output,
    status: finish === "error" ? "failed" : "completed",
    ...(usage
      ? {
          usage: {
            input_tokens: usage.input,
            output_tokens: usage.output,
            ...(usage.cached ? { input_tokens_details: { cached_tokens: usage.cached } } : {}),
            ...(usage.reasoning ? { output_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
          },
        }
      : {}),
  };
}

// re-export alias for discoverability (canonical naming satisfies task)
export const ResponsesToCanonical = responsesToCanonical;
export const CanonicalToResponses = canonicalToResponses;
export const ResponsesStreamToCanonical = responsesStreamToCanonical;

// OpenAI ⇄ canonical translation (request + streaming response).
// Pattern informed by 9router open-sse/translator (MIT); rewritten for the
// single-source canonical design — see NOTICE.
import type {
  CanonicalEvent,
  CanonicalMessage,
  CanonicalRequest,
  ContentPart,
  FinishReason,
  OpenAIChatRequest,
  ToolSpec,
} from "../types.ts";

// ---------- request: OpenAI → canonical ----------

function partsFromOpenAIContent(content: unknown): ContentPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: ContentPart[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const t = (c as { type?: string }).type;
    if (t === "text" && typeof (c as { text?: string }).text === "string") {
      parts.push({ type: "text", text: (c as { text: string }).text });
    } else if (t === "image_url") {
      const url = (c as { image_url?: { url?: string } }).image_url?.url;
      if (url) parts.push({ type: "image", url });
    } else if (t === "input_audio" || t === "file") {
      // not representable in canonical yet — degrade to text marker
      parts.push({ type: "text", text: `[unsupported ${t} content]` });
    }
  }
  return parts;
}

const KNOWN_BODY_KEYS: Record<string, true> = {
  model: true, messages: true, tools: true, tool_choice: true, stream: true,
  max_tokens: true, max_completion_tokens: true, temperature: true, top_p: true,
  stop: true, stream_options: true,
};

export function openaiToCanonical(body: OpenAIChatRequest): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  for (const m of body.messages) {
    const content = partsFromOpenAIContent(m.content);
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        content.push({ type: "tool_call", id: tc.id, name: tc.function?.name ?? "", args: tc.function?.arguments ?? "" });
      }
    }
    if (m.role === "tool" && m.tool_call_id) {
      const text = typeof m.content === "string" ? m.content : partsFromOpenAIContent(m.content).map((p) => (p.type === "text" ? p.text : "")).join("");
      messages.push({ role: "tool", content: [{ type: "tool_result", toolCallId: m.tool_call_id, content: text }] });
      continue;
    }
    const msg: CanonicalMessage = { role: m.role, content };
    if (typeof m.reasoning_content === "string" && m.reasoning_content) msg.reasoning = m.reasoning_content;
    messages.push(msg);
  }

  const tools: ToolSpec[] | undefined = body.tools?.map((t) => ({
    name: t.function?.name ?? "",
    ...(t.function?.description ? { description: t.function.description } : {}),
    parameters: t.function?.parameters ?? {},
  }));

  const stop = body.stop == null ? undefined : Array.isArray(body.stop) ? body.stop : [body.stop];

  const extras: Record<string, unknown> = {};
  for (const k of Object.keys(body)) if (!(k in KNOWN_BODY_KEYS)) extras[k] = (body as Record<string, unknown>)[k];
  if (body.tool_choice !== undefined) extras.tool_choice = body.tool_choice;

  return {
    model: body.model,
    messages,
    ...(tools?.length ? { tools } : {}),
    ...(Object.keys(extras).length ? { extras } : {}),
    stream: body.stream === true,
    ...(body.max_tokens != null || body.max_completion_tokens != null
      ? { maxTokens: (body.max_tokens ?? body.max_completion_tokens) as number }
      : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
    ...(stop ? { stop } : {}),
  };
}

// ---------- request: canonical → OpenAI wire ----------

export function canonicalToOpenAI(req: CanonicalRequest): OpenAIChatRequest {
  const messages: OpenAIChatRequest["messages"] = [];
  for (const m of req.messages) {
    const text = m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
    const toolCalls = m.content.filter((p) => p.type === "tool_call") as Array<Extract<ContentPart, { type: "tool_call" }>>;
    const toolResults = m.content.filter((p) => p.type === "tool_result") as Array<Extract<ContentPart, { type: "tool_result" }>>;
    const images = m.content.filter((p) => p.type === "image") as Array<Extract<ContentPart, { type: "image" }>>;

    if (toolResults.length) {
      for (const tr of toolResults) {
        messages.push({ role: "tool", tool_call_id: tr.toolCallId, content: tr.content });
      }
      continue;
    }
    if (m.role === "assistant" && toolCalls.length) {
      messages.push({
        role: "assistant",
        ...(text ? { content: text } : { content: null }),
        tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } })),
      });
      continue;
    }
    if (images.length) {
      messages.push({
        role: m.role,
        content: [
          ...(text ? [{ type: "text", text }] : []),
          ...images.map((im) => ({ type: "image_url", image_url: { url: im.url } })),
        ],
      });
      continue;
    }
    messages.push({ role: m.role, content: text });
  }

  const out = {
    model: req.model,
    messages,
    ...(req.tools?.length
      ? { tools: req.tools.map((t) => ({ type: "function" as const, function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters } })) }
      : {}),
    stream: req.stream,
  } as Record<string, unknown>;
  if (req.maxTokens) out.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.topP !== undefined) out.top_p = req.topP;
  if (req.stop?.length) out.stop = req.stop;
  if (req.extras) Object.assign(out, req.extras);
  if (req.stream) out.stream_options = { include_usage: true };
  return out as unknown as OpenAIChatRequest;
}

// ---------- response: OpenAI stream → canonical events ----------

const OPENAI_FINISH: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  content_filter: "stop",
};

interface StreamToolAcc {
  id: string;
  name: string;
  args: string;
}

/** Stateful mapper: feed parsed SSE JSON chunks, get canonical events. */
export function openaiStreamToCanonical(): (chunk: unknown) => CanonicalEvent[] {
  const tools = new Map<number, StreamToolAcc>();
  let sawToolCall = false;
  return (chunk: unknown): CanonicalEvent[] => {
    const c = chunk as {
      choices?: Array<{
        delta?: {
          content?: string | null;
          reasoning_content?: string;
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const ev: CanonicalEvent[] = [];
    const ch = c.choices?.[0];
    if (ch?.delta?.content) ev.push({ type: "text_delta", text: ch.delta.content });
    if (ch?.delta?.reasoning_content) ev.push({ type: "reasoning_delta", text: ch.delta.reasoning_content });
    for (const tc of ch?.delta?.tool_calls ?? []) {
      sawToolCall = true;
      const idx = tc.index ?? 0;
      const acc = tools.get(idx) ?? { id: "", name: "", args: "" };
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name += tc.function.name;
      if (tc.function?.arguments) acc.args += tc.function.arguments;
      tools.set(idx, acc);
      // stream args incrementally; announce id/name on first sight
      ev.push({
        type: "tool_call_delta",
        ...(tc.id || !tools.get(idx)?.name ? { id: acc.id, name: acc.name } : {}),
        ...(tc.function?.arguments ? { argsChunk: tc.function.arguments } : {}),
      });
    }
    if (c.usage) {
      ev.push({
        type: "usage",
        input: c.usage.prompt_tokens ?? 0,
        output: c.usage.completion_tokens ?? 0,
        ...(c.usage.prompt_tokens_details?.cached_tokens ? { cached: c.usage.prompt_tokens_details.cached_tokens } : {}),
        ...(c.usage.completion_tokens_details?.reasoning_tokens ? { reasoning: c.usage.completion_tokens_details.reasoning_tokens } : {}),
      });
    }
    if (ch?.finish_reason) {
      const finish: FinishReason = OPENAI_FINISH[ch.finish_reason] ?? "stop";
      ev.push({ type: "done", finish: sawToolCall && finish === "stop" ? "tool_calls" : finish });
    }
    return ev;
  };
}

// ---------- response: canonical events → OpenAI wire ----------

export interface OpenAIStreamEncoder {
  encode(ev: CanonicalEvent): string[]; // SSE `data:` payloads (without trailing blank line)
  close(): string[];
}

export function openaiEncoder(modelTag: string, idTag: string): OpenAIStreamEncoder {
  let sentRole = false;
  let usageChunk: Record<string, unknown> | null = null;
  let doneSent = false;
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id: idTag,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelTag,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usageChunk ? { usage: usageChunk } : {}),
  });
  return {
    encode(ev) {
      switch (ev.type) {
        case "text_delta": {
          sentRole = true;
          return [JSON.stringify(chunk({ role: "assistant", content: ev.text }, null))];
        }
        case "reasoning_signature":
          return []; // no signature concept on the OpenAI wire
        case "reasoning_delta":
          return [JSON.stringify(chunk(sentRole ? { reasoning_content: ev.text } : { role: "assistant", reasoning_content: ev.text }, null))];
        case "tool_call_delta": {
          sentRole = true;
          return [
            JSON.stringify(
              chunk(
                {
                  tool_calls: [
                    {
                      index: 0,
                      ...(ev.id ? { id: ev.id } : {}),
                      ...(ev.name ? { type: "function", function: { name: ev.name, arguments: "" } } : {}),
                      ...(ev.argsChunk && !ev.name ? { function: { arguments: ev.argsChunk } } : {}),
                      ...(ev.argsChunk && ev.name ? { function: { arguments: ev.argsChunk } } : {}),
                    },
                  ],
                },
                null,
              ),
            ),
          ];
        }
        case "usage":
          usageChunk = {
            prompt_tokens: ev.input,
            completion_tokens: ev.output,
            total_tokens: ev.input + ev.output,
            ...(ev.cached ? { prompt_tokens_details: { cached_tokens: ev.cached } } : {}),
          };
          return [];
        case "done": {
          doneSent = true;
          const finish = ev.finish === "tool_calls" ? "tool_calls" : ev.finish === "length" ? "length" : "stop";
          const out = [JSON.stringify(chunk({}, finish)), JSON.stringify(chunk({}, null))];
          out.pop();
          return out.slice(0, 1).concat(usageChunk ? [JSON.stringify({ id: idTag, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelTag, choices: [], usage: usageChunk })] : []);
        }
        case "error":
          return [JSON.stringify({ error: { message: ev.message } })];
      }
    },
    close() {
      if (!doneSent) return [JSON.stringify(chunk({}, "stop"))];
      return [];
    },
  };
}

/** Aggregate canonical stream back into a non-streaming OpenAI completion. */
export async function collectOpenAI(modelTag: string, events: AsyncIterable<CanonicalEvent>) {
  let text = "";
  let reasoning = "";
  const toolCalls = new Map<number, StreamToolAcc>();
  let idx = -1;
  let usage: { input: number; output: number; cached?: number } | null = null;
  let finish: FinishReason = "stop";
  for await (const ev of events) {
    switch (ev.type) {
      case "text_delta":
        text += ev.text;
        break;
      case "reasoning_signature":
        break;
      case "reasoning_delta":
        reasoning += ev.text;
        break;
      case "tool_call_delta": {
        if (ev.id !== undefined || ev.name !== undefined) {
          idx += 1;
          toolCalls.set(idx, { id: ev.id ?? "", name: ev.name ?? "", args: ev.argsChunk ?? "" });
        } else {
          const cur = toolCalls.get(Math.max(idx, 0));
          if (cur && ev.argsChunk) cur.args += ev.argsChunk;
        }
        break;
      }
      case "usage":
        usage = { input: ev.input, output: ev.output, ...(ev.cached ? { cached: ev.cached } : {}) };
        break;
      case "done":
        finish = ev.finish;
        break;
      case "error":
        throw new Error(ev.message);
    }
  }
  const calls = [...toolCalls.values()].map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } }));
  return {
    id: `chatcmpl-rikka-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelTag,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || (calls.length ? null : ""),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason: calls.length ? "tool_calls" : finish === "length" ? "length" : "stop",
      },
    ],
    ...(usage
      ? { usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output, ...(usage.cached ? { prompt_tokens_details: { cached_tokens: usage.cached } } : {}) } }
      : {}),
  };
}

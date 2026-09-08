// Canonical internal format — every wire format translates to/from this.
// Design: single-source (N+M), unlike 9router's pairwise translators.


export type Role = "system" | "user" | "assistant" | "tool";
export type WireFormat = "openai" | "anthropic" | "gemini" | "responses";
export interface TextPart {
  type: "text";
  text: string;
}
export interface ImagePart {
  type: "image";
  /** data URL or remote URL */
  url: string;
}
export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  /** raw JSON string args (streamed incrementally upstream) */
  args: string;
}
export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  content: string;
}
export type ContentPart = TextPart | ImagePart | ToolCallPart | ToolResultPart;

export interface CanonicalMessage {
  role: Role;
  content: ContentPart[];
  /** assistant reasoning/thinking text, if provider surfaced it */
  reasoning?: string;
  /** Anthropic thinking-block signature, replayed on next turn when present */
  reasoningSignature?: string;
}

export interface ToolSpec {
  name: string;
  description?: string;
  /** JSON Schema */
  parameters: unknown;
}

export interface CanonicalRequest {
  /** resolved upstream model id */
  model: string;
  messages: CanonicalMessage[];
  tools?: ToolSpec[];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  /** provider-extension: e.g. Anthropic thinking budget */
  thinking?: { type: "enabled"; budgetTokens?: number };
  /** original client fields we pass through untouched when possible */
  extras?: Record<string, unknown>;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "error" | null;

export type CanonicalEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_signature"; text: string }
  | { type: "tool_call_delta"; id?: string; name?: string; argsChunk?: string }
  | { type: "usage"; input: number; output: number; cached?: number; reasoning?: number }
  | { type: "done"; finish: FinishReason }
  | { type: "error"; status: number; message: string; provider?: string };

export interface Usage {
  input: number;
  output: number;
  cached?: number;
  reasoning?: number;
}

// ---------- request body shapes (wire) ----------

export interface OpenAIChatRequest {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content?: string | Array<Record<string, unknown>> | null;
    name?: string;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
    reasoning_content?: string;
  }>;
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters?: unknown } }>;
  tool_choice?: unknown;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream_options?: { include_usage?: boolean };
  [k: string]: unknown;
}

// ---------- runtime plumbing ----------

export interface Credential {
  connectionId: string;
  apiKey?: string;
  baseUrlOverride?: string;
  headers?: Record<string, string>;
  /** per-connection HTTP(S) proxy URL */
  proxyUrl?: string;
  /** true when proxyUrl came from the auto pool (failure should demote it) */
  proxyAuto?: boolean;
  /** providerSpecificData passthrough (oauth fields land here in Phase 4) */
  extra?: Record<string, unknown>;
}

export interface ExecuteInput {
  request: CanonicalRequest;
  credential: Credential;
  signal?: AbortSignal;
}

export interface Executor {
  id: string;
  execute(input: ExecuteInput): Promise<AsyncIterable<CanonicalEvent>>;
}

export class UpstreamError extends Error {
  override name = "UpstreamError";
  readonly status: number;
  readonly provider?: string;
  readonly retryable: boolean;
  /** Honored by cooldownMsFor: upstream Retry-After in ms, when provided. */
  retryAfterMs?: number;
  constructor(status: number, message: string, provider?: string, retryable = false) {
    super(message);
    this.status = status;
    if (provider !== undefined) this.provider = provider;
    this.retryable = retryable;
  }
}

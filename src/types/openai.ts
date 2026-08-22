/**
 * Types for OpenAI-compatible API
 * Used for Clawdbot integration
 */

export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: string;
  };
}

export type OpenAIMessageContent = string | OpenAIContentPart[] | null;

export interface OpenAIFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIFunctionDef;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded
  };
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "developer" | "tool";
  content: OpenAIMessageContent;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string; // present when role === "tool"
  name?: string; // tool name for role === "tool"
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  user?: string; // Used for session mapping
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  stream_options?: {
    include_usage?: boolean;
  };
  /** Effort hint. Wire-key matches OpenAI convention; semantics map 1:1 to claude --effort. */
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Thinking toggle. Accepts a boolean shorthand or the Anthropic-native object form.
   * Maps to claude's alwaysThinkingEnabled setting via --settings inline JSON.
   * budget_tokens on the object form is currently ignored (CLI accepts only on/off).
   */
  thinking?: boolean | { type: 'enabled' | 'disabled'; budget_tokens?: number };
  /**
   * Verbose logging for this spawn, mapped to claude --debug <filter>.
   * Examples: "api", "api,hooks", "!statsig". Empty string or unset means no --debug.
   */
  debug?: string;
  /**
   * Hard cap on total API spend for this request in USD. Mapped to
   * claude --max-budget-usd. Print-mode only per Anthropic docs;
   * silently no-op in stream-json runs (CLI rejects the flag).
   */
  max_budget_usd?: number;
  /**
   * Permission mode for tool calls. Mapped to claude --permission-mode.
   * Whitelist: default | acceptEdits | plan | auto | dontAsk | bypassPermissions.
   * Strict — unknown values yield HTTP 400 invalid_request_error.
   */
  permission_mode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
  /**
   * Replace claude's default system prompt entirely. Mapped to
   * claude --system-prompt. Combine with append_system_prompt to add
   * task-specific rules after the replacement.
   */
  system_prompt?: string;
  /**
   * Append text to the (possibly already-replaced) system prompt.
   * Mapped to claude --append-system-prompt.
   */
  append_system_prompt?: string;
  /**
   * Select a single named subagent for the session. Mapped to claude --agent.
   * Free-form string — subagent names can be user-defined, so no whitelist.
   */
  agent?: string;
  /**
   * Define ad-hoc subagents inline as a JSON object. Mapped to claude --agents
   * with the JSON serialized as a single CLI argument. Must be a plain object;
   * other shapes (string, array, primitive) throw HTTP 400 invalid_request_error.
   */
  agents?: Record<string, unknown>;
  /**
   * Minimal-mode spawn. Mapped to claude --bare. Skips hooks, skills, plugins,
   * MCP, auto-memory, and CLAUDE.md discovery — leaves only Bash, file read,
   * and file edit available. Faster startup, deterministic context, fewer surprises.
   */
  bare?: boolean;
  /**
   * Disable all slash commands in the subprocess. Mapped to
   * claude --disable-slash-commands. Prevents user prompts that begin with
   * '/' from being misinterpreted as commands.
   */
  disable_slash_commands?: boolean;
  /**
   * JSON Schema the assistant's final answer must conform to. Mapped to
   * claude --json-schema. Print mode in the CLI's sense (`-p`), which includes
   * `--output-format stream-json` — verified on CLI 2.1.232. Must be a plain
   * JSON object; other shapes yield HTTP 400 invalid_request_error. The schema
   * must be loadable by the CLI's draft-07 validator, or the spawn exits 1.
   */
  json_schema?: Record<string, unknown>;
  /**
   * Hard cap on the number of agentic turns the subprocess may take before
   * stopping. Mapped to claude --max-turns (print-mode only). Positive
   * integer; non-integer/zero/negative values are silently dropped.
   */
  max_turns?: number;
  /**
   * OpenAI Structured Outputs format. Only `type: "json_schema"` is acted on
   * by the proxy, and only in the "isolated" profile route — there the inner
   * schema is handed to the CLI's native `--json-schema` at spawn time, so the
   * answer is produced through the validated `StructuredOutput` tool rather
   * than coaxed out of prose. A schema declaring a JSON Schema dialect the CLI
   * validator cannot load falls back to a forced-JSON system prompt. On the
   * default `/v1/chat/completions` route this field is parsed-but-ignored to
   * preserve legacy behaviour.
   */
  response_format?: {
    type?: "json_schema" | "json_object" | "text";
    json_schema?: {
      name?: string;
      schema?: Record<string, unknown>;
      strict?: boolean;
    };
  };
  claude_proxy?: ClaudeProxyRequestExtension;
}

export interface OpenAIChatResponseChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  cache_creation_input_tokens?: number;
  estimated?: boolean;
  estimate_method?: string;
  cost?: UsageCostEstimate;
  cost_usd?: number;
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatResponseChoice[];
  usage: OpenAIUsage;
}

export interface OpenAIToolCallChunkFunction {
  name?: string;
  arguments?: string;
}

export interface OpenAIToolCallChunk {
  index: number;
  id?: string;
  type?: "function";
  function?: OpenAIToolCallChunkFunction;
}

export interface OpenAIChatChunkDelta {
  role?: "assistant";
  content?: string | null;
  tool_calls?: OpenAIToolCallChunk[];
}

export interface OpenAIChatChunkChoice {
  index: number;
  delta: OpenAIChatChunkDelta;
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

export interface OpenAIChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChatChunkChoice[];
  usage?: OpenAIUsage | null;
}

export interface UsageCostEstimate {
  currency: "USD";
  total_cost_usd: number;
  input_cost_usd: number;
  cache_creation_input_cost_usd: number;
  cached_input_cost_usd: number;
  output_cost_usd: number;
  model: string;
  pricing: {
    input_per_1m: number;
    cache_creation_input_per_1m: number;
    cached_input_per_1m: number;
    output_per_1m: number;
    source: string;
    updated_at: string;
    note?: string;
  };
}

export interface OpenAIModel {
  id: string;
  object: "model";
  owned_by: string;
  created?: number;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

export type ClaudeProxySessionMode = "pool" | "sticky" | "stateless";
export type ClaudeProxySessionPolicy = "strict" | "compatible";

export interface ClaudeProxyRequestExtension {
  session_key?: string;
  sessionKey?: string;
  session?: string;
  session_mode?: ClaudeProxySessionMode;
  sessionMode?: ClaudeProxySessionMode;
  mode?: ClaudeProxySessionMode;
  session_ttl_seconds?: number | string;
  sessionTtlSeconds?: number | string;
  ttl_seconds?: number | string;
  session_reset?: boolean | string | number;
  sessionReset?: boolean | string | number;
  reset?: boolean | string | number;
  session_policy?: ClaudeProxySessionPolicy;
  sessionPolicy?: ClaudeProxySessionPolicy;
  policy?: ClaudeProxySessionPolicy;
}

// ── OpenAI Responses API types ──────────────────────────────────────

export interface ResponsesInputTextPart {
  type: "input_text";
  text: string;
}

export interface ResponsesOutputTextPart {
  type: "output_text";
  text: string;
}

export type ResponsesContentPart = ResponsesInputTextPart | ResponsesOutputTextPart;

export interface ResponsesMessageItem {
  role: "user" | "assistant" | "system" | "developer";
  content: string | ResponsesContentPart[];
}

export type ResponsesInput = string | ResponsesMessageItem[];

export interface ResponsesRequest {
  model: string;
  input: ResponsesInput;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  instructions?: string;
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  /** Effort hint. Wire-key matches OpenAI convention; semantics map 1:1 to claude --effort. */
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Thinking toggle. Accepts a boolean shorthand or the Anthropic-native object form.
   * Maps to claude's alwaysThinkingEnabled setting via --settings inline JSON.
   */
  thinking?: boolean | { type: 'enabled' | 'disabled'; budget_tokens?: number };
  /**
   * Verbose logging for this spawn, mapped to claude --debug <filter>.
   */
  debug?: string;
  /**
   * Hard cap on total API spend for this request in USD. Mapped to
   * claude --max-budget-usd. Print-mode only per Anthropic docs.
   */
  max_budget_usd?: number;
  /**
   * Permission mode for tool calls. Mapped to claude --permission-mode.
   */
  permission_mode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
  /** Replace claude's default system prompt entirely. */
  system_prompt?: string;
  /** Append text to the system prompt. */
  append_system_prompt?: string;
  /** Select a single named subagent. */
  agent?: string;
  /** Define ad-hoc subagents inline as a JSON object. */
  agents?: Record<string, unknown>;
  /** Minimal-mode spawn (claude --bare). */
  bare?: boolean;
  /** Disable slash commands in the subprocess. */
  disable_slash_commands?: boolean;
  /** JSON Schema the response must conform to (print-mode only). */
  json_schema?: Record<string, unknown>;
  /** Cap agentic turns (print-mode only). */
  max_turns?: number;
  claude_proxy?: ClaudeProxyRequestExtension;
}

export interface ResponsesOutputMessageContent {
  type: "output_text";
  text: string;
  annotations?: unknown[];
}

export interface ResponsesFunctionCallOutput {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string; // JSON-encoded
  status: "completed";
}

export interface ResponsesOutputMessage {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed";
  content: ResponsesOutputMessageContent[];
}

export type ResponsesOutputItem = ResponsesOutputMessage | ResponsesFunctionCallOutput;

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  cost?: UsageCostEstimate;
  cost_usd?: number;
}

export interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  output: ResponsesOutputItem[];
  output_text: string;
  status: "completed" | "failed" | "incomplete";
  usage: ResponsesUsage;
}

import type { createServerSupabase } from "../supabase";

// Shared types for the LLM provider adapter.
// Callers always speak OpenAI-style tools + { role, content } messages; each
// provider translates internally.

export type Provider = "claude" | "gemini" | "openai";

export type OpenAIToolSchema = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

export type LlmMessage = {
    role: "user" | "assistant";
    content: string;
};

export type NormalizedToolCall = {
    id: string;
    name: string;
    input: Record<string, unknown>;
};

export type NormalizedToolResult = {
    tool_use_id: string;
    content: string;
};

export type StreamCallbacks = {
    onReasoningDelta?: (text: string) => void;
    onReasoningBlockEnd?: () => void;
    onContentDelta?: (text: string) => void;
    onToolCallStart?: (call: NormalizedToolCall) => void;
};

export type UserApiKeys = {
    claude?: string | null;
    gemini?: string | null;
    openai?: string | null;
};

export type StreamChatParams = {
    model: string;
    systemPrompt: string;
    messages: LlmMessage[];
    tools?: OpenAIToolSchema[];
    maxIterations?: number;
    callbacks?: StreamCallbacks;
    runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
    apiKeys?: UserApiKeys;
    /**
     * Enable provider-side reasoning/thinking. Off by default — should only
     * be turned on for interactive chat surfaces where the user actually
     * benefits from seeing the thought stream. Bulk extraction jobs and
     * one-shot completions should leave this off to save tokens and latency.
     */
    enableThinking?: boolean;
    /**
     * Filenames of any documents whose content will be embedded in this LLM
     * call. Reserved for a future data-privacy tier guard (the original
     * free-tier block was removed — see CLAUDE.md "Future capabilities" for
     * the reintroduction plan).
     */
    documentFilenames?: string[];
    /**
     * Optional audit metadata. When provided, the LLM adapter records one
     * audit_log row per streamChatWithTools call (success or error). Omit in
     * call sites that have no user context (rare — most callers should pass
     * it through). The tool dispatcher logs its own tool_call rows
     * independently, so missing this only suppresses the llm_call row.
     */
    audit?: LlmAuditContext;
    /**
     * Optional per-source LLM routing context. When provided, the adapter
     * consults `resolveModelRouting()` before dispatching and uses the
     * resolved model in place of `params.model`. The resolution is recorded
     * into `audit_log.routing_policy_applied` (when `audit` is also present).
     * Today the resolver returns the caller's requested model unchanged in
     * the common case — the seam exists so Phase 7 connectors and the
     * post-launch local-inference adapter plug in without touching dispatch
     * sites. See `backend/src/lib/llm/routing.ts` and decisions.md
     * (2026-05-15).
     */
    routing?: LlmRoutingInput;
};

export type LlmRoutingInput = {
    db: ReturnType<typeof createServerSupabase>;
    projectId?: string | null;
    documentIds?: string[];
};

export type LlmAuditContext = {
    userId: string;
    userEmail?: string;
    projectId?: string | null;
    db: ReturnType<typeof createServerSupabase>;
};

export type StreamChatResult = {
    fullText: string;
};

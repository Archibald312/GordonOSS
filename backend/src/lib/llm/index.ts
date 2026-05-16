import { streamClaude, completeClaudeText } from "./claude";
import { streamGemini, completeGeminiText } from "./gemini";
import { streamOpenAI, completeOpenAIText } from "./openai";
import { providerForModel } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";
import { recordAudit, hashContent } from "../audit";

export * from "./types";
export * from "./models";

function summarizeInputForAudit(params: StreamChatParams): string {
    const messageSummary = params.messages
        .map((m) => `${m.role}:${m.content}`)
        .join("\n---\n");
    return `${params.systemPrompt}\n---\n${messageSummary}`;
}

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const provider = providerForModel(params.model);
    const startedAt = Date.now();
    try {
        const result =
            provider === "claude"
                ? await streamClaude(params)
                : provider === "openai"
                  ? await streamOpenAI(params)
                  : await streamGemini(params);

        if (params.audit) {
            await recordAudit(
                {
                    eventType: "llm_call",
                    userId: params.audit.userId,
                    userEmail: params.audit.userEmail,
                    projectId: params.audit.projectId ?? null,
                    model: params.model,
                    provider,
                    inputHash: hashContent(summarizeInputForAudit(params)),
                    outputHash: hashContent(result.fullText ?? ""),
                    durationMs: Date.now() - startedAt,
                    status: "success",
                },
                params.audit.db,
            );
        }
        return result;
    } catch (err) {
        if (params.audit) {
            await recordAudit(
                {
                    eventType: "llm_call",
                    userId: params.audit.userId,
                    userEmail: params.audit.userEmail,
                    projectId: params.audit.projectId ?? null,
                    model: params.model,
                    provider,
                    inputHash: hashContent(summarizeInputForAudit(params)),
                    durationMs: Date.now() - startedAt,
                    status: "error",
                    errorMessage:
                        err instanceof Error ? err.message : String(err),
                },
                params.audit.db,
            );
        }
        throw err;
    }
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
    documentFilenames?: string[];
}): Promise<string> {
    const provider = providerForModel(params.model);
    if (provider === "claude") return completeClaudeText(params);
    if (provider === "openai") return completeOpenAIText(params);
    return completeGeminiText(params);
}

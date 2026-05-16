import { streamClaude, completeClaudeText } from "./claude";
import { streamGemini, completeGeminiText } from "./gemini";
import { streamOpenAI, completeOpenAIText } from "./openai";
import { providerForModel } from "./models";
import { resolveModelRouting, type ModelRoutingPolicy } from "./routing";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";
import { recordAudit, hashContent } from "../audit";

export * from "./types";
export * from "./models";
export {
    resolveModelRouting,
    type ModelRoutingPolicy,
    type ModelRoutingContext,
    type ModelRoutingSource,
    type ResolvedRouting,
} from "./routing";

function summarizeInputForAudit(params: StreamChatParams): string {
    const messageSummary = params.messages
        .map((m) => `${m.role}:${m.content}`)
        .join("\n---\n");
    return `${params.systemPrompt}\n---\n${messageSummary}`;
}

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    let model = params.model;
    let routingPolicy: ModelRoutingPolicy | undefined;
    if (params.routing) {
        const resolved = await resolveModelRouting(params.routing, params.model);
        model = resolved.model;
        routingPolicy = resolved.policy;
    }

    const provider = providerForModel(model);
    const startedAt = Date.now();
    const dispatchParams: StreamChatParams = { ...params, model };
    try {
        const result =
            provider === "claude"
                ? await streamClaude(dispatchParams)
                : provider === "openai"
                  ? await streamOpenAI(dispatchParams)
                  : await streamGemini(dispatchParams);

        if (params.audit) {
            await recordAudit(
                {
                    eventType: "llm_call",
                    userId: params.audit.userId,
                    userEmail: params.audit.userEmail,
                    projectId: params.audit.projectId ?? null,
                    model,
                    provider,
                    inputHash: hashContent(summarizeInputForAudit(params)),
                    outputHash: hashContent(result.fullText ?? ""),
                    durationMs: Date.now() - startedAt,
                    status: "success",
                    routingPolicyApplied: routingPolicy as
                        | Record<string, unknown>
                        | undefined,
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
                    model,
                    provider,
                    inputHash: hashContent(summarizeInputForAudit(params)),
                    durationMs: Date.now() - startedAt,
                    status: "error",
                    errorMessage:
                        err instanceof Error ? err.message : String(err),
                    routingPolicyApplied: routingPolicy as
                        | Record<string, unknown>
                        | undefined,
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

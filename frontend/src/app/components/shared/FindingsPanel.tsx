"use client";

// Phase 8: minimal findings panel.
//
// Triggers POST /consistency/check on demand and renders the resulting
// mismatches as a stacked list. Each row shows both sides' values, units,
// and quoted snippets. Clicking a row calls onJumpToCitation so the parent
// can swap DocPanel into citation mode and scroll to the byte offset.
//
// Intentionally simple — no severity filtering, no run history, no resolve/
// dismiss controls. Those land in Phase 11 polish when a finance workflow
// actually consumes findings.

import { useCallback, useState } from "react";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";

export interface ConsistencyFinding {
    severity: "mismatch" | "unit_drift" | "orphan";
    entity: string | null;
    concept: string;
    periodKey: string;
    left: {
        documentId: string | null;
        valueNumeric: number | null;
        valueText: string;
        unit: string | null;
        byteOffset: number | null;
        byteLength: number | null;
        quote: string;
    };
    right: {
        kind: "xbrl" | "prose";
        documentId: string | null;
        valueNumeric: number | null;
        valueText: string;
        unit: string | null;
        byteOffset: number | null;
        byteLength: number | null;
        quote: string;
    };
    details: Record<string, unknown>;
}

interface CheckResponse {
    run_id: string;
    findings_total: number;
    findings_inserted: number;
    tuple_counts: Record<string, number>;
    findings: Array<{
        severity: ConsistencyFinding["severity"];
        entity: string | null;
        concept: string;
        periodKey: string;
        left: ConsistencyFinding["left"];
        right: ConsistencyFinding["right"];
        details: Record<string, unknown>;
    }>;
}

interface Props {
    documentId: string;
    crossDoc?: boolean;
    onJumpToCitation?: (args: {
        documentId: string;
        quote: string;
        byteOffset: number | null;
    }) => void;
}

const SEVERITY_LABEL: Record<ConsistencyFinding["severity"], string> = {
    mismatch: "Mismatch",
    unit_drift: "Unit drift",
    orphan: "No XBRL counterpart",
};

const SEVERITY_TONE: Record<ConsistencyFinding["severity"], string> = {
    mismatch: "bg-red-50 text-red-700 border-red-200",
    unit_drift: "bg-amber-50 text-amber-700 border-amber-200",
    orphan: "bg-slate-50 text-slate-600 border-slate-200",
};

export function FindingsPanel({ documentId, crossDoc = false, onJumpToCitation }: Props) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [findings, setFindings] = useState<ConsistencyFinding[] | null>(null);
    const [runId, setRunId] = useState<string | null>(null);

    const runCheck = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const token = session?.access_token;
            const apiBase =
                process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
            const resp = await fetch(`${apiBase}/consistency/check`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({
                    document_id: documentId,
                    cross_doc: crossDoc,
                }),
            });
            if (!resp.ok) {
                const body = await resp.text();
                throw new Error(`HTTP ${resp.status}: ${body}`);
            }
            const data = (await resp.json()) as CheckResponse;
            setFindings(data.findings);
            setRunId(data.run_id);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, [documentId, crossDoc]);

    return (
        <div className="flex flex-col gap-2 rounded-md border border-gray-200 bg-white p-3 text-sm">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-gray-500" />
                    <span className="font-medium text-gray-800">
                        Consistency check
                    </span>
                </div>
                <button
                    type="button"
                    onClick={runCheck}
                    disabled={loading}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-60"
                >
                    {loading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {findings == null ? "Run check" : "Re-run"}
                </button>
            </div>
            {error ? (
                <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                    {error}
                </div>
            ) : null}
            {findings != null && findings.length === 0 ? (
                <div className="text-xs text-gray-600">
                    No mismatches found.
                    {runId ? (
                        <span className="ml-1 text-gray-400">
                            (run {runId.slice(0, 8)})
                        </span>
                    ) : null}
                </div>
            ) : null}
            {findings != null && findings.length > 0 ? (
                <ul className="flex flex-col gap-2">
                    {findings.map((f, i) => (
                        <li
                            key={`${f.concept}-${f.periodKey}-${i}`}
                            className={`rounded border p-2 ${SEVERITY_TONE[f.severity]}`}
                        >
                            <div className="flex items-center gap-2 text-xs font-semibold">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                <span>{SEVERITY_LABEL[f.severity]}</span>
                                <span className="font-normal text-gray-600">
                                    · {f.concept}
                                </span>
                                <span className="ml-auto font-normal text-gray-500">
                                    {f.periodKey.replace(/^(?:duration|instant):/, "")}
                                </span>
                            </div>
                            <div className="mt-1 grid grid-cols-2 gap-2 text-xs text-gray-700">
                                <button
                                    type="button"
                                    onClick={() =>
                                        f.left.documentId &&
                                        onJumpToCitation?.({
                                            documentId: f.left.documentId,
                                            quote: f.left.quote,
                                            byteOffset: f.left.byteOffset,
                                        })
                                    }
                                    className="text-left rounded border border-gray-200 bg-white/60 p-1.5 hover:bg-white"
                                >
                                    <div className="text-[10px] uppercase text-gray-500">
                                        Prose
                                    </div>
                                    <div className="font-mono text-[11px]">
                                        {f.left.valueText}
                                        {f.left.unit ? (
                                            <span className="ml-1 text-gray-500">
                                                {f.left.unit}
                                            </span>
                                        ) : null}
                                    </div>
                                    <div className="mt-1 line-clamp-2 italic text-gray-600">
                                        {f.left.quote}
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    onClick={() =>
                                        f.right.documentId &&
                                        onJumpToCitation?.({
                                            documentId: f.right.documentId,
                                            quote: f.right.quote,
                                            byteOffset: f.right.byteOffset,
                                        })
                                    }
                                    className="text-left rounded border border-gray-200 bg-white/60 p-1.5 hover:bg-white"
                                >
                                    <div className="text-[10px] uppercase text-gray-500">
                                        {f.right.kind === "xbrl"
                                            ? "XBRL"
                                            : "Sibling doc"}
                                    </div>
                                    <div className="font-mono text-[11px]">
                                        {f.right.valueText || "—"}
                                        {f.right.unit ? (
                                            <span className="ml-1 text-gray-500">
                                                {f.right.unit}
                                            </span>
                                        ) : null}
                                    </div>
                                    <div className="mt-1 line-clamp-2 italic text-gray-600">
                                        {f.right.quote}
                                    </div>
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

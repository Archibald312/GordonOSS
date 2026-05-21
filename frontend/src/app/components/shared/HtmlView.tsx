"use client";

// Phase 8 follow-up: render an HTML document inside the doc tab.
//
// EDGAR-ingested filings whose HTML→PDF transcoding failed (e.g. when
// LibreOffice isn't installed) land in storage as raw .htm bytes. The
// chat page would otherwise route them to DocxView and show a parse
// error. This viewer fetches the bytes via the existing download route
// and renders them in a sandboxed iframe via `srcDoc` — no scripts run,
// no styles leak, and the user can scroll/select text normally.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface Props {
    documentId: string;
    versionId?: string | null;
}

export function HtmlView({ documentId }: Props) {
    const [html, setHtml] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const token = session?.access_token;
                const apiBase =
                    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
                const resp = await fetch(
                    `${apiBase}/single-documents/${documentId}/docx`,
                    {
                        headers: token
                            ? { Authorization: `Bearer ${token}` }
                            : undefined,
                    },
                );
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const text = await resp.text();
                if (!cancelled) setHtml(text);
            } catch (e) {
                if (!cancelled)
                    setError(e instanceof Error ? e.message : String(e));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [documentId]);

    if (error) {
        return (
            <div className="p-4 text-sm text-red-700">
                Failed to load document: {error}
            </div>
        );
    }
    if (html == null) {
        return (
            <div className="flex h-full items-center justify-center text-gray-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading…
            </div>
        );
    }
    return (
        <iframe
            title="Document"
            // Sandbox restricts script execution and form submission;
            // allow-same-origin is omitted so the iframe is fully isolated.
            sandbox=""
            srcDoc={html}
            className="h-full w-full border-0 bg-white"
        />
    );
}

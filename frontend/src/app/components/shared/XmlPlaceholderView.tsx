"use client";

// Phase 8 follow-up: XBRL instance docs are machine-readable XML that's
// useless to render in a user-facing viewer. EDGAR ingest persists them
// as `documents` rows so they're auditable, but the viewer should show
// a placeholder rather than feed 2MB of XML into DocxView (which crashes
// on it). Same treatment applies to any .xml that lands in the explorer.

import { FileCode2 } from "lucide-react";

interface Props {
    filename: string;
}

export function XmlPlaceholderView({ filename }: Props) {
    const isXbrl =
        /\.xml$/i.test(filename) &&
        !/FilingSummary\.xml$/i.test(filename) &&
        !/_(?:cal|def|lab|pre)\.xml$/i.test(filename);
    return (
        <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <FileCode2 className="h-12 w-12 text-gray-300" />
            <p className="mt-3 font-serif text-lg text-gray-700">
                {isXbrl ? "XBRL instance document" : "XML data file"}
            </p>
            <p className="mt-1 max-w-md text-sm text-gray-500">
                {isXbrl
                    ? "This file holds the filing's structured facts (concept, period, value, unit). It's used by the consistency check — open the prose 10-K and click the Consistency button to compare against these facts."
                    : "This file is machine-readable XML; it isn't meant to be rendered."}
            </p>
            <p className="mt-3 text-xs text-gray-400 font-mono">{filename}</p>
        </div>
    );
}

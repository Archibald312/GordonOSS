"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ExcelJS from "exceljs";
import { format as formatNum, isValidFormat } from "numfmt";
import { Loader2 } from "lucide-react";
import { useFetchDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import type { CitationQuote } from "./types";

interface Props {
    documentId: string;
    versionId?: string | null;
    fileType?: string | null;
    quotes?: CitationQuote[];
    refetchKey?: number;
}

interface ParsedCell {
    addr: string;
    row: number;
    col: number;
    display: string;
    rawValue: string | number | boolean | null;
    numFmt?: string;
    formula?: string;
}

interface ParsedSheet {
    name: string;
    rowCount: number;
    colCount: number;
    cells: Map<string, ParsedCell>;
}

function colNumberToLetters(col: number): string {
    let s = "";
    let n = col;
    while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s || "A";
}

function applyNumFmt(raw: unknown, numFmt: string | undefined): string | null {
    if (numFmt && typeof raw === "number" && isValidFormat(numFmt)) {
        try {
            return formatNum(numFmt, raw);
        } catch {
            return null;
        }
    }
    return null;
}

function cellToParts(v: unknown): {
    display: string;
    raw: string | number | boolean | null;
    formula?: string;
} {
    if (v === null || v === undefined || v === "") {
        return { display: "", raw: null };
    }
    if (typeof v === "string") return { display: v, raw: v };
    if (typeof v === "number") return { display: String(v), raw: v };
    if (typeof v === "boolean") return { display: v ? "TRUE" : "FALSE", raw: v };
    if (v instanceof Date) {
        const iso = v.toISOString().slice(0, 10);
        return { display: iso, raw: iso };
    }
    if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.text === "string") return { display: o.text, raw: o.text };
        if (Array.isArray(o.richText)) {
            const display = (o.richText as { text?: string }[])
                .map((r) => r.text ?? "")
                .join("");
            return { display, raw: display };
        }
        if (typeof o.formula === "string" || typeof o.sharedFormula === "string") {
            const formula = (o.formula as string) ?? (o.sharedFormula as string);
            const inner = cellToParts(o.result);
            return { display: inner.display, raw: inner.raw, formula };
        }
        if (typeof o.error === "string") return { display: o.error, raw: o.error };
    }
    return { display: String(v), raw: String(v) };
}

async function parseSpreadsheet(
    buf: ArrayBuffer,
    fileType: string | null | undefined,
    filename: string,
): Promise<ParsedSheet[]> {
    if (fileType === "csv") {
        const text = new TextDecoder("utf-8").decode(buf).replace(/^﻿/, "");
        const rows = parseCsvLight(text);
        const cells = new Map<string, ParsedCell>();
        let maxCol = 0;
        rows.forEach((cols, rIdx) => {
            cols.forEach((raw, cIdx) => {
                if (raw === "") return;
                const row = rIdx + 1;
                const col = cIdx + 1;
                if (col > maxCol) maxCol = col;
                const addr = `${colNumberToLetters(col)}${row}`;
                const asNum = Number(raw);
                const isNumeric =
                    raw.trim() !== "" &&
                    Number.isFinite(asNum) &&
                    /^-?\d+(\.\d+)?$/.test(raw.trim());
                cells.set(addr, {
                    addr,
                    row,
                    col,
                    display: raw,
                    rawValue: isNumeric ? asNum : raw,
                });
            });
        });
        const sheetName = filename.replace(/\.csv$/i, "") || "Sheet1";
        return [{ name: sheetName, rowCount: rows.length, colCount: maxCol, cells }];
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheets: ParsedSheet[] = [];
    wb.eachSheet((ws) => {
        const cells = new Map<string, ParsedCell>();
        let maxRow = 0;
        let maxCol = 0;
        ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
                const parts = cellToParts(cell.value);
                if (!parts.display && parts.raw === null) return;
                if (rowNumber > maxRow) maxRow = rowNumber;
                if (colNumber > maxCol) maxCol = colNumber;
                const addr = `${colNumberToLetters(colNumber)}${rowNumber}`;
                const numFmt =
                    typeof cell.numFmt === "string" ? cell.numFmt : undefined;
                const formatted = applyNumFmt(parts.raw, numFmt);
                cells.set(addr, {
                    addr,
                    row: rowNumber,
                    col: colNumber,
                    display: formatted ?? parts.display,
                    rawValue: parts.raw,
                    numFmt,
                    formula: parts.formula,
                });
            });
        });
        sheets.push({ name: ws.name, rowCount: maxRow, colCount: maxCol, cells });
    });
    return sheets;
}

function parseCsvLight(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i++;
                continue;
            }
            field += ch;
            i++;
            continue;
        }
        if (ch === '"') { inQuotes = true; i++; continue; }
        if (ch === ",") { row.push(field); field = ""; i++; continue; }
        if (ch === "\r") {
            if (text[i + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; i += 2; continue; }
            row.push(field); rows.push(row); row = []; field = ""; i++; continue;
        }
        if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
        field += ch; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
    return rows;
}

export function XlsxView({ documentId, versionId, fileType, quotes, refetchKey }: Props) {
    const { bytes, loading, error } = useFetchDocxBytes(documentId, versionId, refetchKey);
    const [sheets, setSheets] = useState<ParsedSheet[] | null>(null);
    const [parseErr, setParseErr] = useState<string | null>(null);
    const [activeSheet, setActiveSheet] = useState<string | null>(null);
    const [selected, setSelected] = useState<{ sheet: string; addr: string } | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        let cancelled = false;
        if (!bytes) { setSheets(null); return; }
        parseSpreadsheet(bytes, fileType, "")
            .then((s) => {
                if (cancelled) return;
                setSheets(s);
                setParseErr(null);
                if (s.length && !activeSheet) setActiveSheet(s[0].name);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setParseErr(e instanceof Error ? e.message : String(e));
            });
        return () => { cancelled = true; };
    }, [bytes, fileType, activeSheet]);

    // Jump to + highlight a cell when the citation's cellRef changes.
    const target = useMemo(() => {
        const cellRef = quotes?.find((q) => q.cellRef)?.cellRef;
        if (!cellRef) return null;
        const [sheet, addr] = cellRef.includes("!")
            ? [cellRef.slice(0, cellRef.lastIndexOf("!")), cellRef.slice(cellRef.lastIndexOf("!") + 1)]
            : [null, cellRef];
        return { sheet, addr: addr.toUpperCase() };
    }, [quotes]);

    useEffect(() => {
        if (!target || !sheets) return;
        const sheetName = target.sheet ?? sheets[0]?.name;
        if (!sheetName) return;
        if (activeSheet !== sheetName) {
            setActiveSheet(sheetName);
            return;
        }
        const root = containerRef.current;
        if (!root) return;
        const el = root.querySelector<HTMLElement>(
            `[data-sheet="${cssEscape(sheetName)}"][data-cell="${cssEscape(target.addr)}"]`,
        );
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setSelected({ sheet: sheetName, addr: target.addr });
        el.classList.add("xlsx-cell-highlight");
        const timeout = setTimeout(() => el.classList.remove("xlsx-cell-highlight"), 2500);
        return () => clearTimeout(timeout);
    }, [target, sheets, activeSheet]);

    if (loading && !sheets) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading workbook...
            </div>
        );
    }
    if (error || parseErr) {
        return (
            <div className="flex h-full items-center justify-center px-6 text-sm text-red-600">
                Failed to load spreadsheet: {error ?? parseErr}
            </div>
        );
    }
    if (!sheets || sheets.length === 0) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-gray-500">
                Empty workbook.
            </div>
        );
    }

    const current = sheets.find((s) => s.name === activeSheet) ?? sheets[0];
    const selectedCell =
        selected && selected.sheet === current.name
            ? current.cells.get(selected.addr)
            : undefined;

    // Formula bar shows formula prefixed with "=" when present, else the raw
    // value (so users can see "0.1294" behind a displayed "12.94%").
    const formulaBarValue = selectedCell
        ? selectedCell.formula
            ? `=${selectedCell.formula}`
            : selectedCell.rawValue !== null && selectedCell.rawValue !== undefined
                ? String(selectedCell.rawValue)
                : ""
        : "";

    return (
        <div ref={containerRef} className="flex h-full min-h-0 flex-col">
            <style>{`
              .xlsx-cell-highlight {
                background-color: #fef08a !important;
                box-shadow: 0 0 0 2px #eab308 inset;
                transition: background-color 0.5s ease;
              }
              .xlsx-cell-selected {
                box-shadow: 0 0 0 2px #2563eb inset !important;
              }
            `}</style>

            {/* Formula bar */}
            <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-2 py-1.5">
                <div className="shrink-0 rounded border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-[11px] text-gray-700 min-w-[80px] text-center">
                    {selected ? selected.addr : ""}
                </div>
                <div className="text-gray-400 font-mono text-xs">fx</div>
                <input
                    readOnly
                    value={formulaBarValue}
                    placeholder=""
                    className="flex-1 rounded border border-gray-200 bg-white px-2 py-1 font-mono text-[11px] text-gray-800 outline-none focus:border-blue-400"
                />
            </div>

            {/* Sheet tabs */}
            {sheets.length > 1 && (
                <div className="flex gap-1 overflow-x-auto border-b border-gray-200 px-1 pt-1">
                    {sheets.map((s) => (
                        <button
                            key={s.name}
                            onClick={() => { setActiveSheet(s.name); setSelected(null); }}
                            className={`shrink-0 rounded-t-md border border-b-0 px-3 py-1 text-xs ${
                                current.name === s.name
                                    ? "bg-white border-gray-300 text-gray-900"
                                    : "bg-gray-50 border-transparent text-gray-500 hover:bg-gray-100"
                            }`}
                        >
                            {s.name}
                        </button>
                    ))}
                </div>
            )}

            {/* Grid */}
            <div className="flex-1 overflow-auto bg-white">
                <table className="border-collapse text-xs">
                    <thead>
                        <tr>
                            <th className="sticky top-0 left-0 z-30 border border-gray-300 bg-gray-100 px-2 py-1 text-[10px] font-medium text-gray-500 min-w-[40px]" />
                            {Array.from({ length: current.colCount }, (_, cIdx) => {
                                const col = cIdx + 1;
                                const letter = colNumberToLetters(col);
                                return (
                                    <th
                                        key={letter}
                                        className="sticky top-0 z-20 border border-gray-300 bg-gray-100 px-2 py-1 text-center text-[10px] font-medium text-gray-600 min-w-[80px]"
                                    >
                                        {letter}
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {Array.from({ length: current.rowCount }, (_, rIdx) => {
                            const row = rIdx + 1;
                            return (
                                <tr key={row}>
                                    <td className="sticky left-0 z-10 border border-gray-300 bg-gray-100 px-2 py-1 text-right font-mono text-[10px] text-gray-500 min-w-[40px]">
                                        {row}
                                    </td>
                                    {Array.from({ length: current.colCount }, (_, cIdx) => {
                                        const col = cIdx + 1;
                                        const addr = `${colNumberToLetters(col)}${row}`;
                                        const cell = current.cells.get(addr);
                                        const isSelected =
                                            selected?.sheet === current.name &&
                                            selected?.addr === addr;
                                        const isNumeric =
                                            cell &&
                                            (typeof cell.rawValue === "number" ||
                                                (cell.numFmt &&
                                                    /[#0%$]/.test(cell.numFmt)));
                                        return (
                                            <td
                                                key={addr}
                                                data-sheet={current.name}
                                                data-cell={addr}
                                                onClick={() =>
                                                    setSelected({ sheet: current.name, addr })
                                                }
                                                className={`cursor-cell border border-gray-200 px-2 py-1 align-top text-gray-800 ${
                                                    isNumeric ? "text-right tabular-nums font-mono" : ""
                                                } ${
                                                    isSelected ? "xlsx-cell-selected" : ""
                                                }`}
                                                title={
                                                    cell?.formula
                                                        ? `=${cell.formula}`
                                                        : undefined
                                                }
                                            >
                                                {cell?.display ?? ""}
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function cssEscape(s: string): string {
    if (typeof (window as unknown as { CSS?: { escape?: (s: string) => string } }).CSS?.escape === "function") {
        return (window as unknown as { CSS: { escape: (s: string) => string } }).CSS.escape(s);
    }
    return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

import ExcelJS from "exceljs";
import { format as formatNum, isValidFormat } from "numfmt";

export type XlsxCellType = "string" | "number" | "boolean" | "date" | "formula" | "error" | "hyperlink" | "richtext" | "empty";

export interface XlsxCell {
    addr: string;
    row: number;
    col: number;
    /** Display value with the workbook's number format applied (e.g. "12.94%"). */
    value: string;
    rawValue: string | number | boolean | null;
    /** Excel number-format code (e.g. "0.00%", "$#,##0.00") if the cell has one. */
    numFmt?: string;
    formula?: string;
    type: XlsxCellType;
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

export interface XlsxSheet {
    name: string;
    rowCount: number;
    colCount: number;
    cells: XlsxCell[];
    mergedRanges: string[];
}

export interface XlsxExtract {
    sheets: XlsxSheet[];
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

function formatDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function cellValueToString(v: unknown): { display: string; raw: string | number | boolean | null; type: XlsxCellType; formula?: string } {
    if (v === null || v === undefined || v === "") {
        return { display: "", raw: null, type: "empty" };
    }
    if (typeof v === "string") return { display: v, raw: v, type: "string" };
    if (typeof v === "number") return { display: Number.isFinite(v) ? String(v) : "", raw: v, type: "number" };
    if (typeof v === "boolean") return { display: v ? "TRUE" : "FALSE", raw: v, type: "boolean" };
    if (v instanceof Date) return { display: formatDate(v), raw: formatDate(v), type: "date" };
    if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        // ExcelJS hyperlink cell value
        if (typeof o.text === "string" && typeof o.hyperlink === "string") {
            return { display: o.text, raw: o.text, type: "hyperlink" };
        }
        // Rich text
        if (Array.isArray(o.richText)) {
            const display = (o.richText as { text?: string }[])
                .map((r) => r.text ?? "")
                .join("");
            return { display, raw: display, type: "richtext" };
        }
        // Formula cell
        if (typeof o.formula === "string" || typeof o.sharedFormula === "string") {
            const formula = (o.formula as string) ?? (o.sharedFormula as string);
            const result = o.result;
            const inner = cellValueToString(result);
            return {
                display: inner.display,
                raw: inner.raw,
                type: "formula",
                formula,
            };
        }
        // Error cell
        if (typeof o.error === "string") {
            return { display: o.error, raw: o.error, type: "error" };
        }
    }
    return { display: String(v), raw: String(v), type: "string" };
}

export async function extractXlsx(buf: Buffer): Promise<XlsxExtract> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    const sheets: XlsxSheet[] = [];
    wb.eachSheet((ws) => {
        const cells: XlsxCell[] = [];
        let maxRow = 0;
        let maxCol = 0;
        ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
                const parsed = cellValueToString(cell.value);
                if (parsed.type === "empty") return;
                if (rowNumber > maxRow) maxRow = rowNumber;
                if (colNumber > maxCol) maxCol = colNumber;
                const numFmt =
                    typeof cell.numFmt === "string" ? cell.numFmt : undefined;
                const formatted = applyNumFmt(parsed.raw, numFmt);
                cells.push({
                    addr: `${colNumberToLetters(colNumber)}${rowNumber}`,
                    row: rowNumber,
                    col: colNumber,
                    value: formatted ?? parsed.display,
                    rawValue: parsed.raw,
                    numFmt,
                    formula: parsed.formula,
                    type: parsed.type,
                });
            });
        });
        const merged: string[] = [];
        const wsAny = ws as unknown as { model?: { merges?: string[] } };
        const modelMerges = wsAny.model?.merges;
        if (Array.isArray(modelMerges)) merged.push(...modelMerges);
        sheets.push({
            name: ws.name,
            rowCount: maxRow,
            colCount: maxCol,
            cells,
            mergedRanges: merged,
        });
    });
    return { sheets };
}

/**
 * Render an extracted workbook as a citation-friendly text view for an LLM.
 * Each non-empty cell becomes one line: `[Sheet!Address] value`. Sheets are
 * separated by a header. Empty cells are skipped so the model sees a dense
 * representation; row/column structure is preserved by including the address.
 */
export function flattenXlsxForLLM(extract: XlsxExtract): string {
    const parts: string[] = [];
    for (const sheet of extract.sheets) {
        parts.push(
            `=== Sheet: ${sheet.name} (rows=${sheet.rowCount}, cols=${sheet.colCount}) ===`,
        );
        if (sheet.mergedRanges.length) {
            parts.push(`Merged ranges: ${sheet.mergedRanges.join(", ")}`);
        }
        const sorted = [...sheet.cells].sort((a, b) =>
            a.row !== b.row ? a.row - b.row : a.col - b.col,
        );
        let lastRow = -1;
        const rowLines: string[] = [];
        let line: string[] = [];
        for (const c of sorted) {
            if (c.row !== lastRow) {
                if (line.length) rowLines.push(line.join("  "));
                line = [];
                lastRow = c.row;
            }
            const v = c.value.replace(/\s+/g, " ").trim();
            const tag = `[${sheet.name}!${c.addr}]`;
            line.push(`${tag} ${v}`);
        }
        if (line.length) rowLines.push(line.join("  "));
        parts.push(rowLines.join("\n"));
        parts.push("");
    }
    return parts.join("\n").trimEnd();
}

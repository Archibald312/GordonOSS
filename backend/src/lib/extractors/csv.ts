import type { XlsxCell, XlsxExtract, XlsxSheet } from "./xlsx";

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

/**
 * RFC 4180-ish CSV parser. Handles quoted values, escaped quotes (""),
 * embedded newlines, and either \n or \r\n line terminators. Delimiter
 * defaults to comma but can be overridden for TSV.
 */
export function parseCsv(text: string, delimiter = ","): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < n && text[i + 1] === '"') {
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
        if (ch === '"') {
            inQuotes = true;
            i++;
            continue;
        }
        if (ch === delimiter) {
            row.push(field);
            field = "";
            i++;
            continue;
        }
        if (ch === "\r") {
            // swallow; handled at \n or alone
            if (i + 1 < n && text[i + 1] === "\n") {
                row.push(field);
                rows.push(row);
                row = [];
                field = "";
                i += 2;
                continue;
            }
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
            i++;
            continue;
        }
        if (ch === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
            i++;
            continue;
        }
        field += ch;
        i++;
    }
    // Flush the trailing field/row unless the file ended with a newline.
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    // Drop a trailing empty row produced by a file-ending newline.
    if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
        rows.pop();
    }
    return rows;
}

export function extractCsv(buf: Buffer, sheetName = "Sheet1"): XlsxExtract {
    // Strip a UTF-8 BOM if present.
    let text = buf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = parseCsv(text);
    const cells: XlsxCell[] = [];
    let maxCol = 0;
    rows.forEach((cols, rIdx) => {
        cols.forEach((raw, cIdx) => {
            if (raw === "") return;
            const row = rIdx + 1;
            const col = cIdx + 1;
            if (col > maxCol) maxCol = col;
            const addr = `${colNumberToLetters(col)}${row}`;
            const asNum = Number(raw);
            const isNumeric = raw.trim() !== "" && Number.isFinite(asNum) && /^-?\d+(\.\d+)?$/.test(raw.trim());
            cells.push({
                addr,
                row,
                col,
                value: raw,
                rawValue: isNumeric ? asNum : raw,
                type: isNumeric ? "number" : "string",
            });
        });
    });
    const sheet: XlsxSheet = {
        name: sheetName,
        rowCount: rows.length,
        colCount: maxCol,
        cells,
        mergedRanges: [],
    };
    return { sheets: [sheet] };
}

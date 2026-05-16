"use client";

import ExcelJS from "exceljs";
import type { ColumnConfig, GordonDocument, TabularCell } from "../shared/types";
import { preprocessCitations, type ParsedCitation } from "./citation-utils";

interface FormattedCell {
    text: string;
    citations: ParsedCitation[];
}

function formatCellForExport(cell: TabularCell | undefined): FormattedCell {
    if (!cell) return { text: "", citations: [] };
    if (cell.status === "pending" || cell.status === "generating") {
        return { text: "", citations: [] };
    }
    if (cell.status === "error") return { text: "Error", citations: [] };
    const summary = cell.content?.summary;
    if (!summary) return { text: "", citations: [] };
    const { processed, citations } = preprocessCitations(summary);
    const text = processed
        .replace(/§\d+§/g, "")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/[ \t]+/g, " ")
        .trim();
    return { text, citations };
}

function buildCommentText(
    citations: ParsedCitation[],
    docFilename: string,
): string {
    return citations
        .map((c, i) => {
            const quote = c.quote.length > 240 ? `${c.quote.slice(0, 240)}…` : c.quote;
            return `[${i + 1}] ${docFilename} — Page ${c.page}\n  "${quote}"`;
        })
        .join("\n\n");
}

function sanitizeFilename(name: string): string {
    return (
        name
            .replace(/[\\/:*?"<>|]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || "Tabular Review"
    );
}

export async function exportTabularReviewToExcel(params: {
    reviewTitle: string;
    columns: ColumnConfig[];
    documents: GordonDocument[];
    cells: TabularCell[];
}) {
    const { reviewTitle, columns, documents, cells } = params;

    const sortedCols = [...columns].sort((a, b) => a.index - b.index);
    const cellMap = new Map<string, TabularCell>();
    for (const c of cells) cellMap.set(`${c.document_id}:${c.column_index}`, c);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Review");

    ws.columns = [
        { header: "Document", width: 40 },
        ...sortedCols.map((c) => ({ header: c.name, width: 40 })),
    ];

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: "middle" };
    headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF3F4F6" },
    };

    for (const doc of documents) {
        const formattedCols = sortedCols.map((col) =>
            formatCellForExport(cellMap.get(`${doc.id}:${col.index}`)),
        );
        const row: string[] = [doc.filename, ...formattedCols.map((f) => f.text)];
        const excelRow = ws.addRow(row);
        excelRow.alignment = { vertical: "top", wrapText: true };

        // Attach per-cell ExcelJS comments containing the citation list. This
        // is the audit trail: every claim in a tabular review cell can be
        // traced back to the source document + page + verbatim quote without
        // leaving Excel.
        formattedCols.forEach((f, i) => {
            if (!f.citations.length) return;
            const comment = buildCommentText(f.citations, doc.filename);
            const excelCell = excelRow.getCell(i + 2); // +1 for 1-indexing, +1 for the Document column
            excelCell.note = {
                texts: [{ text: comment }],
                margins: { insetmode: "auto" },
            };
        });
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizeFilename(reviewTitle)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

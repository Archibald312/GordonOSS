import type { ToolDefinition } from "./types";

export const readTableCells: ToolDefinition<"read_table_cells"> = {
    name: "read_table_cells",
    schema: {
        type: "function",
        function: {
            name: "read_table_cells",
            description:
                "Read the extracted cell content from the tabular review. Each cell contains the value extracted for a specific column from a specific document. Pass col_indices and/or row_indices (0-based) to read a subset; omit either to read all columns or all rows.",
            parameters: {
                type: "object",
                properties: {
                    col_indices: {
                        type: "array",
                        items: { type: "integer" },
                        description:
                            "0-based column indices to read (e.g. [0, 2]). Omit to read all columns.",
                    },
                    row_indices: {
                        type: "array",
                        items: { type: "integer" },
                        description:
                            "0-based document (row) indices to read (e.g. [0, 1]). Omit to read all rows.",
                    },
                },
            },
        },
    },
    availableWhen: (ctx) => ctx.tabularStore != null,
    async execute(args, toolCallId, ctx) {
        // availableWhen guarantees tabularStore is set when this runs.
        const tabularStore = ctx.tabularStore!;
        const colIndices = args.col_indices as number[] | undefined;
        const rowIndices = args.row_indices as number[] | undefined;

        const filteredCols = colIndices?.length
            ? tabularStore.columns.filter((_, i) => colIndices.includes(i))
            : tabularStore.columns;
        const filteredDocs = rowIndices?.length
            ? tabularStore.documents.filter((_, i) => rowIndices.includes(i))
            : tabularStore.documents;

        const label = `${filteredCols.length} ${filteredCols.length === 1 ? "column" : "columns"} × ${filteredDocs.length} ${filteredDocs.length === 1 ? "row" : "rows"}`;
        ctx.write(
            `data: ${JSON.stringify({ type: "doc_read_start", filename: label })}\n\n`,
        );

        const lines: string[] = [];
        for (const col of filteredCols) {
            const colPos = tabularStore.columns.findIndex(
                (c) => c.index === col.index,
            );
            for (const doc of filteredDocs) {
                const rowPos = tabularStore.documents.findIndex(
                    (d) => d.id === doc.id,
                );
                const cell = tabularStore.cells.get(`${col.index}:${doc.id}`);
                lines.push(
                    `[COL:${colPos} "${col.name}" | ROW:${rowPos} "${doc.filename}"]`,
                );
                if (cell?.summary) {
                    lines.push(`Summary: ${cell.summary}`);
                    if (cell.flag) lines.push(`Flag: ${cell.flag}`);
                    if (cell.reasoning)
                        lines.push(`Reasoning: ${cell.reasoning}`);
                } else {
                    lines.push(`(not yet generated)`);
                }
                lines.push("");
            }
        }

        ctx.write(
            `data: ${JSON.stringify({ type: "doc_read", filename: label })}\n\n`,
        );

        return {
            toolResult: {
                role: "tool",
                tool_call_id: toolCallId,
                content: lines.join("\n") || "No cells found.",
            },
            sideEffects: { docsRead: [{ filename: label }] },
        };
    },
};

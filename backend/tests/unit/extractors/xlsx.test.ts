import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { extractXlsx, flattenXlsxForLLM } from "../../../src/lib/extractors/xlsx";

async function buildFixture(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Income Statement");
    ws.getCell("A1").value = "Line item";
    ws.getCell("B1").value = "2024";
    ws.getCell("C1").value = "2023";
    ws.getCell("A2").value = "Revenue";
    ws.getCell("B2").value = 4200000;
    ws.getCell("C2").value = 3800000;
    ws.getCell("A3").value = "Growth";
    ws.getCell("B3").value = { formula: "B2/C2-1", result: 0.10526 };

    const ws2 = wb.addWorksheet("Notes");
    ws2.getCell("A1").value = "Prepared by Gordon";
    ws2.mergeCells("A2:C2");
    ws2.getCell("A2").value = "Q4 2024 reporting package";

    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out);
}

describe("extractXlsx", () => {
    it("extracts cells with addresses, types, and formulas", async () => {
        const buf = await buildFixture();
        const extract = await extractXlsx(buf);
        expect(extract.sheets).toHaveLength(2);
        const [income, notes] = extract.sheets;
        expect(income.name).toBe("Income Statement");

        const byAddr = new Map(income.cells.map((c) => [c.addr, c]));
        expect(byAddr.get("A1")?.value).toBe("Line item");
        expect(byAddr.get("B1")?.value).toBe("2024");
        expect(byAddr.get("B2")?.type).toBe("number");
        expect(byAddr.get("B2")?.rawValue).toBe(4200000);

        const b3 = byAddr.get("B3");
        expect(b3?.type).toBe("formula");
        expect(b3?.formula).toBe("B2/C2-1");
        expect(b3?.rawValue).toBeCloseTo(0.10526, 4);

        expect(notes.mergedRanges.some((r) => r.includes("A2:C2"))).toBe(true);
    });

    it("flattenXlsxForLLM produces sheet-tagged citation-friendly text", async () => {
        const buf = await buildFixture();
        const extract = await extractXlsx(buf);
        const text = flattenXlsxForLLM(extract);
        expect(text).toContain("=== Sheet: Income Statement");
        expect(text).toContain("[Income Statement!A1] Line item");
        expect(text).toContain("[Income Statement!B2] 4200000");
        expect(text).toContain("=== Sheet: Notes");
        expect(text).toContain("[Notes!A2] Q4 2024 reporting package");
    });

    it("skips empty cells", async () => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Sparse");
        ws.getCell("A1").value = "x";
        ws.getCell("Z99").value = "y";
        const buf = Buffer.from(await wb.xlsx.writeBuffer());
        const extract = await extractXlsx(buf);
        const cells = extract.sheets[0].cells;
        expect(cells).toHaveLength(2);
        expect(cells.map((c) => c.addr).sort()).toEqual(["A1", "Z99"]);
    });
});

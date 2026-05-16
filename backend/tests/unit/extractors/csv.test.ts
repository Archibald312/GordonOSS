import { describe, it, expect } from "vitest";
import { extractCsv, parseCsv } from "../../../src/lib/extractors/csv";

describe("parseCsv", () => {
    it("parses simple rows", () => {
        const rows = parseCsv("a,b,c\n1,2,3\n");
        expect(rows).toEqual([
            ["a", "b", "c"],
            ["1", "2", "3"],
        ]);
    });

    it("handles quoted fields with embedded commas and escaped quotes", () => {
        const rows = parseCsv('name,note\n"Smith, John","says ""hi"""\n');
        expect(rows).toEqual([
            ["name", "note"],
            ["Smith, John", 'says "hi"'],
        ]);
    });

    it("handles embedded newlines in quoted fields", () => {
        const rows = parseCsv('a,b\n"line1\nline2",x\n');
        expect(rows).toEqual([
            ["a", "b"],
            ["line1\nline2", "x"],
        ]);
    });

    it("handles CRLF line endings", () => {
        const rows = parseCsv("a,b\r\n1,2\r\n");
        expect(rows).toEqual([
            ["a", "b"],
            ["1", "2"],
        ]);
    });

    it("does not require a trailing newline", () => {
        expect(parseCsv("a,b\n1,2")).toEqual([
            ["a", "b"],
            ["1", "2"],
        ]);
    });
});

describe("extractCsv", () => {
    it("produces an xlsx-shaped extract with cell addresses and numeric typing", () => {
        const buf = Buffer.from("Item,Q1,Q2\nRevenue,100,120\nCost,40,50\n", "utf8");
        const extract = extractCsv(buf, "Sales");
        expect(extract.sheets).toHaveLength(1);
        const sheet = extract.sheets[0];
        expect(sheet.name).toBe("Sales");
        const byAddr = new Map(sheet.cells.map((c) => [c.addr, c]));
        expect(byAddr.get("A1")?.value).toBe("Item");
        expect(byAddr.get("B2")?.type).toBe("number");
        expect(byAddr.get("B2")?.rawValue).toBe(100);
        expect(byAddr.get("A2")?.type).toBe("string");
    });

    it("strips a UTF-8 BOM", () => {
        const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b\n1,2\n", "utf8")]);
        const extract = extractCsv(buf);
        const byAddr = new Map(extract.sheets[0].cells.map((c) => [c.addr, c]));
        expect(byAddr.get("A1")?.value).toBe("a");
    });
});

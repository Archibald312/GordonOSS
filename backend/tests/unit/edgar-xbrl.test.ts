import { describe, it, expect } from "vitest";
import { extractXbrlFacts } from "../../src/lib/connectors/edgar/xbrl";

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance"
      xmlns:xbrli="http://www.xbrl.org/2003/instance"
      xmlns:us-gaap="http://fasb.org/us-gaap/2024">
  <xbrli:context id="FD2024Q4YTD">
    <xbrli:period>
      <xbrli:startDate>2023-10-01</xbrli:startDate>
      <xbrli:endDate>2024-09-28</xbrli:endDate>
    </xbrli:period>
  </xbrli:context>
  <xbrli:context id="I2024Q4">
    <xbrli:period>
      <xbrli:instant>2024-09-28</xbrli:instant>
    </xbrli:period>
  </xbrli:context>
  <us-gaap:Revenues contextRef="FD2024Q4YTD" unitRef="USD" decimals="-6">383285000000</us-gaap:Revenues>
  <us-gaap:Assets contextRef="I2024Q4" unitRef="USD" decimals="-6">364980000000</us-gaap:Assets>
  <us-gaap:CommonStockSharesOutstanding contextRef="I2024Q4" unitRef="shares" decimals="INF">15115823000</us-gaap:CommonStockSharesOutstanding>
  <us-gaap:DocumentType contextRef="FD2024Q4YTD">10-K</us-gaap:DocumentType>
</xbrl>`;

describe("extractXbrlFacts", () => {
    it("extracts numeric and textual facts with their period resolved", () => {
        const facts = extractXbrlFacts(FIXTURE);
        const byConcept = new Map(facts.map((f) => [f.concept, f]));

        const rev = byConcept.get("us-gaap:Revenues");
        expect(rev).toBeDefined();
        expect(rev?.valueNumeric).toBe(383285000000);
        expect(rev?.unit).toBe("USD");
        expect(rev?.decimals).toBe(-6);
        expect(rev?.period).toEqual({
            kind: "duration",
            start: "2023-10-01",
            end: "2024-09-28",
        });

        const assets = byConcept.get("us-gaap:Assets");
        expect(assets?.period).toEqual({
            kind: "instant",
            date: "2024-09-28",
        });
        expect(assets?.valueNumeric).toBe(364980000000);

        const shares = byConcept.get("us-gaap:CommonStockSharesOutstanding");
        // decimals="INF" → null (filer asserted full precision, no rounding).
        expect(shares?.decimals).toBeNull();
        expect(shares?.unit).toBe("shares");

        const docType = byConcept.get("us-gaap:DocumentType");
        expect(docType?.valueNumeric).toBeNull();
        expect(docType?.valueText).toBe("10-K");
    });

    it("skips elements without a contextRef", () => {
        const xml = `<xbrl xmlns="http://www.xbrl.org/2003/instance">
            <us-gaap:NoContext>123</us-gaap:NoContext>
        </xbrl>`;
        expect(extractXbrlFacts(xml)).toEqual([]);
    });

    it("returns an empty list when there's no recognizable root", () => {
        expect(extractXbrlFacts("<root/>")).toEqual([]);
    });
});

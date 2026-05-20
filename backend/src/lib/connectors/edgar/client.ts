// EDGAR HTTP client.
//
// SEC fair-use policy requires every request to carry a User-Agent that
// identifies the requester (company + contact email). We read that from
// EDGAR_USER_AGENT — if it's unset, every call errors fast. SEC also rate-
// limits to ~10 req/s; we keep the client thin and rely on the caller (the
// connector) to throttle, since ingest already runs serially per accession.
//
// All response parsing lives here so the rest of the connector can stay
// data-oriented and easy to mock in tests.

type FetchFn = typeof fetch;

const TICKER_LOOKUP_URL = "https://www.sec.gov/files/company_tickers.json";

export type SecCompany = {
    cik: string;
    ticker: string;
    name: string;
};

export type SecFiling = {
    accession_number: string;
    form: string;
    filing_date: string;
    /** Period the filing covers — yyyy-mm-dd or "". */
    report_date: string;
    /** The single document the SEC marks as the "primary" doc. */
    primary_document: string;
    /** All documents in the filing (primary + exhibits + xbrl). */
    documents: SecFilingDocument[];
};

export type SecFilingDocument = {
    /** Filename inside the accession folder, e.g. "aapl-20240928.htm". */
    name: string;
    /** Document type (10-K, EX-99.1, XML, etc.) from index.json. */
    type: string;
    size: number;
};

export type EdgarClientOptions = {
    userAgent?: string;
    fetchImpl?: FetchFn;
};

export class EdgarClient {
    private readonly userAgent: string;
    private readonly fetchImpl: FetchFn;

    constructor(opts: EdgarClientOptions = {}) {
        const ua = opts.userAgent ?? process.env.EDGAR_USER_AGENT;
        if (!ua || !ua.includes("@")) {
            throw new Error(
                "EDGAR_USER_AGENT must be set to a string containing a contact email (SEC fair-use policy).",
            );
        }
        this.userAgent = ua;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }

    private async getJson<T>(url: string): Promise<T> {
        const res = await this.fetchImpl(url, {
            headers: {
                "User-Agent": this.userAgent,
                Accept: "application/json",
            },
        });
        if (!res.ok) {
            throw new Error(`EDGAR GET ${url} failed: ${res.status}`);
        }
        return (await res.json()) as T;
    }

    private async getBytes(url: string): Promise<Buffer> {
        const res = await this.fetchImpl(url, {
            headers: { "User-Agent": this.userAgent },
        });
        if (!res.ok) {
            throw new Error(`EDGAR GET ${url} failed: ${res.status}`);
        }
        const ab = await res.arrayBuffer();
        return Buffer.from(ab);
    }

    /**
     * Resolve a ticker symbol to its 10-digit CIK + company name.
     * SEC ships this list as a single JSON object at a stable URL; we hit
     * it directly each call. For an in-process cache, wrap this method.
     */
    async lookupByTicker(ticker: string): Promise<SecCompany | null> {
        const upper = ticker.trim().toUpperCase();
        if (!upper) return null;
        const data = await this.getJson<
            Record<string, { cik_str: number; ticker: string; title: string }>
        >(TICKER_LOOKUP_URL);
        for (const row of Object.values(data)) {
            if (row.ticker.toUpperCase() === upper) {
                return {
                    cik: String(row.cik_str).padStart(10, "0"),
                    ticker: row.ticker,
                    name: row.title,
                };
            }
        }
        return null;
    }

    /**
     * Return the submission history for a CIK. The shape used here is the
     * subset of /submissions/CIK{cik}.json the connector actually needs.
     */
    async getRecentFilings(cik: string, opts: {
        formTypes?: string[];
        limit?: number;
    } = {}): Promise<Array<{
        accession_number: string;
        form: string;
        filing_date: string;
        report_date: string;
        primary_document: string;
    }>> {
        const padded = cik.replace(/\D/g, "").padStart(10, "0");
        const data = await this.getJson<{
            filings: {
                recent: {
                    accessionNumber: string[];
                    form: string[];
                    filingDate: string[];
                    reportDate: string[];
                    primaryDocument: string[];
                };
            };
        }>(`https://data.sec.gov/submissions/CIK${padded}.json`);

        const r = data.filings.recent;
        const out: Array<{
            accession_number: string;
            form: string;
            filing_date: string;
            report_date: string;
            primary_document: string;
        }> = [];
        const wanted = opts.formTypes?.map((f) => f.toUpperCase()) ?? null;
        const limit = opts.limit ?? 50;
        for (let i = 0; i < r.accessionNumber.length; i++) {
            const form = r.form[i] ?? "";
            if (wanted && !wanted.includes(form.toUpperCase())) continue;
            out.push({
                accession_number: r.accessionNumber[i] ?? "",
                form,
                filing_date: r.filingDate[i] ?? "",
                report_date: r.reportDate[i] ?? "",
                primary_document: r.primaryDocument[i] ?? "",
            });
            if (out.length >= limit) break;
        }
        return out;
    }

    /**
     * Load the full document index for a single filing. EDGAR exposes this
     * per-accession at /Archives/edgar/data/{cik}/{accessionNoDashes}/index.json.
     */
    async getFilingIndex(
        cik: string,
        accessionNumber: string,
    ): Promise<SecFiling> {
        const padded = cik.replace(/\D/g, "").padStart(10, "0").replace(/^0+/, "");
        const accNoDashes = accessionNumber.replace(/-/g, "");
        const base = `https://www.sec.gov/Archives/edgar/data/${padded}/${accNoDashes}`;
        const data = await this.getJson<{
            directory: {
                item: Array<{ name: string; type: string; size: string }>;
            };
        }>(`${base}/index.json`);

        const items = data.directory.item ?? [];
        const docs: SecFilingDocument[] = items
            .filter((it) => it.name && !it.name.endsWith("/"))
            .map((it) => ({
                name: it.name,
                type: it.type ?? "",
                size: Number.parseInt(it.size ?? "0", 10) || 0,
            }));
        // Best-effort: pick the primary doc as the largest htm/pdf if no
        // other signal is available. The caller can override.
        const primary =
            docs.find((d) => /^(10-?k|10-?q|8-?k|s-?1)$/i.test(d.type))?.name ??
            docs.find((d) => /\.htm$/i.test(d.name))?.name ??
            docs[0]?.name ??
            "";
        return {
            accession_number: accessionNumber,
            form: "",
            filing_date: "",
            report_date: "",
            primary_document: primary,
            documents: docs,
        };
    }

    /** Stream a single filing-document's bytes. */
    async getFilingDocument(
        cik: string,
        accessionNumber: string,
        filename: string,
    ): Promise<Buffer> {
        const padded = cik.replace(/\D/g, "").padStart(10, "0").replace(/^0+/, "");
        const accNoDashes = accessionNumber.replace(/-/g, "");
        const url = `https://www.sec.gov/Archives/edgar/data/${padded}/${accNoDashes}/${filename}`;
        return this.getBytes(url);
    }
}

import { promisify } from "util";
import JSZip from "jszip";

let _convert:
  | ((buf: Buffer, ext: string, filter: undefined) => Promise<Buffer>)
  | null = null;

async function getConvert() {
  if (!_convert) {
    const libre = await import("libreoffice-convert");
    _convert = promisify(libre.default.convert.bind(libre.default));
  }
  return _convert;
}

/**
 * Some older Windows/Word archives store .docx entries with backslash
 * separators (e.g. `word\document.xml`). Mammoth and LibreOffice both look
 * up entries by exact string and miss those files, producing empty output
 * or conversion failures. Rewrite any such entries to the canonical
 * forward-slash form before handing the buffer off.
 */
export async function normalizeDocxZipPaths(buffer: Buffer): Promise<Buffer> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return buffer;
  }
  const renames: [string, string][] = [];
  zip.forEach((relativePath) => {
    if (relativePath.includes("\\")) {
      renames.push([relativePath, relativePath.replace(/\\/g, "/")]);
    }
  });
  if (renames.length === 0) return buffer;
  for (const [oldPath, newPath] of renames) {
    const entry = zip.file(oldPath);
    if (!entry) continue;
    const content = await entry.async("nodebuffer");
    zip.remove(oldPath);
    zip.file(newPath, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/**
 * Convert a DOCX/DOC buffer to PDF using LibreOffice.
 * Throws if LibreOffice is not installed or conversion fails.
 */
export async function docxToPdf(buffer: Buffer): Promise<Buffer> {
  const convert = await getConvert();
  const normalized = await normalizeDocxZipPaths(buffer);
  return convert(normalized, ".pdf", undefined);
}

/**
 * Convert a legacy .xls (BIFF) buffer to modern .xlsx via LibreOffice so the
 * rest of the pipeline only has to deal with one spreadsheet parser (ExcelJS).
 * Throws if LibreOffice is not installed or conversion fails.
 */
export async function xlsToXlsx(buffer: Buffer): Promise<Buffer> {
  const convert = await getConvert();
  return convert(buffer, ".xlsx", undefined);
}

/**
 * Convert an HTML buffer to PDF via LibreOffice. Used by the EDGAR connector
 * (Phase 7) to normalize SEC filings — most are HTML and we transcode at
 * ingest so citations work identically to manual PDF uploads.
 * Throws if LibreOffice is not installed or conversion fails.
 */
export async function htmlToPdf(buffer: Buffer): Promise<Buffer> {
  const convert = await getConvert();
  return convert(buffer, ".pdf", undefined);
}

export function convertedPdfKey(userId: string, docId: string): string {
  return `converted-pdfs/${userId}/${docId}.pdf`;
}

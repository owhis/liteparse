import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PdfEngine, PdfDocument, PageData, Path, Image, Annotation } from "./interface.js";
import { TextItem } from "../../core/types.js";
import { PdfiumRenderer } from "./pdfium-renderer.js";

/** PDF.js internal document type - opaque to our code */
interface PdfJsDocument {
  numPages: number;
  getPage(pageNum: number): Promise<PdfJsPage>;
  getMetadata(): Promise<unknown>;
  destroy(): Promise<void>;
}

/** PDF.js internal page type */
interface PdfJsPage {
  getViewport(params: { scale: number }): PdfJsViewport;
  getTextContent(): Promise<PdfJsTextContent>;
  cleanup(): Promise<void>;
}

/** PDF.js viewport type */
interface PdfJsViewport {
  width: number;
  height: number;
  transform: number[];
}

/** PDF.js text content type */
interface PdfJsTextContent {
  items: PdfJsTextItem[];
}

/** PDF.js text item type */
interface PdfJsTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
}

/** Extended PdfDocument with internal PDF.js document reference */
interface PdfJsExtendedDocument extends PdfDocument {
  _pdfDocument: PdfJsDocument;
}

// Dynamic import of PDF.js
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// From dist/src/engines/pdf/ we need to go up to dist/src/vendor/pdfjs
const PDFJS_DIR = join(__dirname, "../../vendor/pdfjs");

// Import PDF.js dynamically
await import(`${PDFJS_DIR}/pdf.mjs`);
const pdfjs = await import(`${PDFJS_DIR}/pdf.mjs`);
const { getDocument } = pdfjs;

const CMAP_URL = `${PDFJS_DIR}/cmaps/`;
const STANDARD_FONT_DATA_URL = `${PDFJS_DIR}/standard_fonts/`;
const CMAP_PACKED = true;

/**
 * Extract rotation angle in degrees from PDF transformation matrix
 * Matrix format: [a, b, c, d, e, f] where rotation is atan2(b, a)
 */
function getRotation(transform: number[]): number {
  return Math.atan2(transform[1], transform[0]) * (180 / Math.PI);
}

/**
 * Multiply two transformation matrices
 */
function multiplyMatrices(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Apply transformation matrix to a point
 */
function applyTransformation(
  point: { x: number; y: number },
  transform: number[]
): { x: number; y: number } {
  return {
    x: point.x * transform[0] + point.y * transform[2] + transform[4],
    y: point.x * transform[1] + point.y * transform[3] + transform[5],
  };
}

/**
 * Decompose transformation matrix to get scale factors using SVD
 * This computes the singular values of the 2D transformation matrix
 */
function singularValueDecompose2dScale(m: number[]): { x: number; y: number } {
  // Create transpose of the 2x2 part of the matrix
  const transpose = [m[0], m[2], m[1], m[3]];

  // Multiply matrix m with its transpose to get eigenvalues
  const a = m[0] * transpose[0] + m[1] * transpose[2];
  const b = m[0] * transpose[1] + m[1] * transpose[3];
  const c = m[2] * transpose[0] + m[3] * transpose[2];
  const d = m[2] * transpose[1] + m[3] * transpose[3];

  // Solve the second degree polynomial to get roots (eigenvalues)
  const first = (a + d) / 2;
  const second = Math.sqrt((a + d) ** 2 - 4 * (a * d - c * b)) / 2;
  const sx = first + second || 1;
  const sy = first - second || 1;

  // Scale values are the square roots of the eigenvalues
  return { x: Math.sqrt(sx), y: Math.sqrt(sy) };
}

// Pre-compiled regex patterns for string decoding (avoid recompilation per item)
const BUGGY_FONT_MARKER_REGEX = /:->|>_(\d+)_\d+_<|<-:/g;
const BUGGY_FONT_MARKER_CHECK = ":->|>";
const PIPE_PATTERN_REGEX = /\s*\|([^|])\|\s*/g;

export class PdfJsEngine implements PdfEngine {
  name = "pdfjs";
  private pdfiumRenderer: PdfiumRenderer | null = null;
  private currentPdfPath: string | null = null;

  async loadDocument(filePath: string): Promise<PdfDocument> {
    const data = new Uint8Array(await fs.readFile(filePath));

    // Store path for PDFium rendering
    this.currentPdfPath = filePath;

    const loadingTask = getDocument({
      data,
      cMapUrl: CMAP_URL,
      cMapPacked: CMAP_PACKED,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    });

    const pdfDocument = await loadingTask.promise;
    const metadata = await pdfDocument.getMetadata();

    return {
      numPages: pdfDocument.numPages,
      data,
      metadata,
      _pdfDocument: pdfDocument,
    } as PdfJsExtendedDocument;
  }

  async extractPage(doc: PdfDocument, pageNum: number): Promise<PageData> {
    const pdfDocument = (doc as PdfJsExtendedDocument)._pdfDocument;
    const page = await pdfDocument.getPage(pageNum);

    // Get viewport
    const viewport = page.getViewport({ scale: 1.0 });

    // Extract text content
    const textContent = await page.getTextContent();
    const viewportWidth = viewport.width;
    const viewportHeight = viewport.height;
    const viewportTransform = viewport.transform;

    const textItems: TextItem[] = [];
    for (const item of textContent.items) {
      // Skip items with zero dimensions
      if (item.height === 0 || item.width === 0) continue;

      // Apply viewport transformation to convert PDF coordinates to screen coordinates
      // This properly handles Y-axis flip (PDF is bottom-up, screen is top-down)
      const cm = multiplyMatrices(viewportTransform, item.transform);

      // Get lower-left corner (text space origin)
      const ll = applyTransformation({ x: 0, y: 0 }, cm);

      // Get scale factors to properly size the bounding box
      const scale = singularValueDecompose2dScale(item.transform);

      // Get upper-right corner
      const ur = applyTransformation({ x: item.width / scale.x, y: item.height / scale.y }, cm);

      // Calculate final bounding box in viewport space
      const left = Math.min(ll.x, ur.x);
      const right = Math.max(ll.x, ur.x);
      const top = Math.min(ll.y, ur.y);
      const bottom = Math.max(ll.y, ur.y);

      // Skip items that are off-page (negative coordinates or beyond page bounds)
      if (top < 0 || left < 0 || top > viewportHeight || left > viewportWidth) continue;

      const width = right - left;
      const height = bottom - top;

      // Calculate rotation from combined transformation matrix
      let rotation = getRotation(cm);
      // Normalize to 0-360 range
      if (rotation < 0) {
        rotation += 360;
      }

      // Decode buggy font markers from PDF.js (only if marker is present)
      // Format: :->|>_<charCode>_<fontChar>_<|<-:
      let decodedStr = item.str;
      if (decodedStr.includes(BUGGY_FONT_MARKER_CHECK)) {
        BUGGY_FONT_MARKER_REGEX.lastIndex = 0; // Reset regex state
        decodedStr = decodedStr.replace(BUGGY_FONT_MARKER_REGEX, (_: string, charCode: string) =>
          String.fromCharCode(parseInt(charCode))
        );
      }

      // Handle pipe-separated characters: " |a|  |r|  |X| " -> "arX"
      // Some PDFs encode text with characters separated by pipes and spaces
      if (decodedStr.includes("|")) {
        PIPE_PATTERN_REGEX.lastIndex = 0; // Reset regex state
        const matches = [...decodedStr.matchAll(PIPE_PATTERN_REGEX)];
        if (matches.length > 0) {
          decodedStr = matches.map((m) => m[1]).join("");
        }
      }

      textItems.push({
        str: decodedStr,
        x: left,
        y: top,
        width,
        height,
        w: width,
        h: height,
        r: rotation,
        fontName: item.fontName,
        fontSize: Math.sqrt(
          item.transform[0] * item.transform[0] + item.transform[1] * item.transform[1]
        ),
      });
    }

    // For now, paths and images are empty - we'll add extraction logic later
    const paths: Path[] = [];
    const images: Image[] = [];

    // Skip annotation extraction - not currently used in processing pipeline
    // Can be re-enabled if needed for link extraction, etc.
    const annotations: Annotation[] = [];

    await page.cleanup();

    return {
      pageNum,
      width: viewport.width,
      height: viewport.height,
      textItems,
      paths,
      images,
      annotations,
    };
  }

  async extractAllPages(
    doc: PdfDocument,
    maxPages?: number,
    targetPages?: string
  ): Promise<PageData[]> {
    const numPages = Math.min(doc.numPages, maxPages || doc.numPages);

    const pages: PageData[] = [];

    // Parse target pages if specified
    let pageNumbers: number[];
    if (targetPages) {
      pageNumbers = this.parseTargetPages(targetPages, numPages);
    } else {
      pageNumbers = Array.from({ length: numPages }, (_, i) => i + 1);
    }

    for (const pageNum of pageNumbers) {
      if (maxPages && pages.length >= maxPages) {
        break;
      }
      const pageData = await this.extractPage(doc, pageNum);
      pages.push(pageData);
    }

    return pages;
  }

  async renderPageImage(_doc: PdfDocument, pageNum: number, dpi: number): Promise<Buffer> {
    // Use PDFium for rendering (more robust with inline images)
    if (!this.currentPdfPath) {
      throw new Error("PDF path not available for rendering");
    }

    if (!this.pdfiumRenderer) {
      this.pdfiumRenderer = new PdfiumRenderer();
    }

    return await this.pdfiumRenderer.renderPageToBuffer(this.currentPdfPath, pageNum, dpi);
  }

  async close(doc: PdfDocument): Promise<void> {
    const pdfDocument = (doc as PdfJsExtendedDocument)._pdfDocument;
    if (pdfDocument && pdfDocument.destroy) {
      await pdfDocument.destroy();
    }

    // Clean up PDFium renderer (only if it was initialized)
    if (this.pdfiumRenderer) {
      await this.pdfiumRenderer.close();
      this.pdfiumRenderer = null;
    }
    this.currentPdfPath = null;
  }

  private parseTargetPages(targetPages: string, maxPages: number): number[] {
    const pages: number[] = [];
    const parts = targetPages.split(",");

    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.includes("-")) {
        // Range: "1-5"
        const [start, end] = trimmed.split("-").map((n) => parseInt(n.trim()));
        for (let i = start; i <= Math.min(end, maxPages); i++) {
          if (i >= 1) {
            pages.push(i);
          }
        }
      } else {
        // Single page: "10"
        const pageNum = parseInt(trimmed);
        if (pageNum >= 1 && pageNum <= maxPages) {
          pages.push(pageNum);
        }
      }
    }

    return [...new Set(pages)].sort((a, b) => a - b);
  }
}

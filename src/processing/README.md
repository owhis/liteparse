# src/processing/

The processing module is the **heart of LiteParse** - responsible for transforming raw PDF content into structured, spatially-aware text. This is where text extraction, layout reconstruction, table detection, and OCR integration happen.

## Files

### grid.ts
**Thin wrapper around gridProjection.ts.**

Simply merges user config with defaults and calls `projectPagesToGridComplete`. Exists to provide a cleaner import path and handle configuration.

---

### gridProjection.ts (~1500 lines)
**The most complex module - spatial text layout reconstruction.**

This is the core algorithm that converts raw PDF text items into readable, properly-ordered text that preserves document layout.

**Key Concepts:**

1. **Anchors**: Track where text aligns on the page
   - `anchorLeft` - Text left-edges (column starts)
   - `anchorRight` - Text right-edges (column ends)
   - `anchorCenter` - Text centers (centered content)

2. **Snap Types**: How text aligns to columns
   - `left` - Text snaps to left edge of a column
   - `right` - Text snaps to right edge
   - `center` - Text is centered
   - `floating` - Unaligned/justified text

3. **Forward Anchors**: Carry alignment information between lines
   - Enables consistent column detection across the page
   - Prevents duplicate text detection (`isDup` flag)

**Algorithm Flow:**
1. Build bounding boxes from text items and OCR data
2. Sort text into lines by Y-coordinate
3. Extract anchor points from all text items
4. Detect text snapping (left, right, center, or floating)
5. Project lines onto character grid with proper spacing
6. Apply markup tags (highlight, underline, strikeout)
7. Clean up sparse blocks and margins

**Constants:**
- `FLOATING_SPACES = 2` - Minimum spaces between floating text
- `COLUMN_SPACES = 4` - Minimum spaces between columns
- `SMALL_FONT_SIZE_THRESHOLD = 2` - Filter very small text (2pt)

**Design Decisions:**
- **Anchor rounding**: Groups anchor x-coords by nearest 1/4 unit to handle slight variations
- **Sparse block compression**: Reduces excessive whitespace in sparse layouts (>70% whitespace)
- **Vertical line anchoring**: Uses PDF path lines to establish column boundaries
- **Small text filtering**: Lines with >50% small text can be filtered (configurable)

---

### bbox.ts
**Bounding box construction and OCR integration.**

**Key Functions:**

`buildBbox(pageData, config)` - Main function that:
1. Converts `TextItem[]` to `ProjectionTextBox[]` with additional metadata
2. Processes embedded images for OCR if enabled
3. Filters images by size, position, and type
4. Filters OCR results that overlap with existing text (50% spatial threshold)
5. Filters OCR results whose text content already exists in native PDF text (content-based deduplication)
6. Returns combined text boxes for grid projection

`buildBoundingBoxes(textItems)` - Simple conversion of text items to `BoundingBox[]` format (x1, y1, x2, y2).

**OCR Filtering Constants:**
- `OCR_CONFIDENCE_THRESHOLD = 0.1` - Minimum OCR confidence
- `OCR_OVERLAP_THRESHOLD = 0.5` - Reject OCR if >50% overlaps existing text
- `MAX_IMAGES_PER_PAGE = 10` - Limit images processed per page
- `MIN_IMAGE_DIMENSION = 12` - Skip tiny images
- `MIN_IMAGE_AREA = 200` - Skip small-area images

**Design Decisions:**
- **Spatial overlap filtering**: Prevents duplicate text when OCR and PDF extraction detect the same content at the same location. Native PDF text is preferred over OCR.
- **Content-based deduplication**: Filters OCR text that matches existing PDF text content regardless of position. This handles cases like watermarks or embedded images containing text that already appears elsewhere on the page.

---

### tables.ts
**Heuristic table detection via line intersection analysis.**

Detects tables with explicit borders (outlined tables). Does not detect borderless tables.

**Algorithm:**
1. Extract horizontal and vertical lines from PDF paths
2. Cluster nearby lines to reduce noise (5px threshold)
3. Find line intersections (tolerance: 3px)
4. Create grid cells from intersection points
5. Assign text items to cells based on center point
6. Validate table has minimum rows/cols (2x2, 4 cells min)

**Key Functions:**
- `detectTables(paths, textItems)` - Main entry point
- `extractLines(paths)` - Gets lines from paths and rectangles
- `findIntersections(horizontal, vertical)` - Finds grid points
- `createCellsFromIntersections(intersections)` - Builds cell grid
- `assignTextToCells(cells, textItems)` - Maps text to cells

**Output:**
```typescript
interface DetectedTable {
  x1, y1, x2, y2: number;  // Table bounds
  rows, cols: number;       // Grid dimensions
  cells: TableCell[];       // Cell data with text
}
```

**Limitation:** Only works with outlined/bordered tables. Borderless tables require layout analysis not yet implemented.

---

### pathUtils.ts
**Extract lines from PDF vector paths.**

Provides input for table detection and layout analysis.

`getVerticalAndHorizontalLinesFromPagePaths(config, paths)`:
- Extracts vertical lines (x1 ≈ x2) from line paths
- Extracts horizontal lines (y1 ≈ y2) from line paths
- Extracts edges from rectangle paths
- Returns `{ verticalLines, horizontalLines }`

Used by `gridProjection.ts` to establish column anchors from visible lines.

---

### ocrUtils.ts
**OCR result parsing and coordinate conversion.**

**Key Functions:**

`parseImageOcrBlocks(image)`:
- Converts OCR bounding boxes from image space to page space
- Handles scale factors and coordinate ratios
- Returns `OcrBlock[]` with both page-space and raw coordinates

`easyOcrResultLinesToList(stdOutResult)`:
- Parses EasyOCR stdout format into structured data
- Format: `([[x1,y1], [x2,y2], [x3,y3], [x4,y4]], 'text', confidence)`

**Coordinate Systems:**
- **Image space**: Coordinates relative to the OCR'd image
- **Page space**: Coordinates relative to the PDF page viewport
- Conversion uses `xRatio = image.width / coords.w`

---

### textUtils.ts
**Unicode subscript and superscript conversion.**

Used for scientific notation and mathematical text.

- `strToSubscriptString(str)` - Converts "H2O" → "H₂O"
- `strToPostScript(str)` - Converts "x2" → "x²"

Supports: digits 0-9, +/-, common letters (a-z, A-Z subset)

If any character lacks a Unicode equivalent, returns original string unchanged.

---

### cleanText.ts
**Post-processing text cleanup.**

`cleanRawText(pages, config)`:
1. **Margin removal** (per page):
   - Detects consistent left margin (leading whitespace)
   - Removes top margin (empty lines at start)
   - Removes bottom margin (empty lines at end)
   - Trims right margin (trailing whitespace)
2. **Null character removal**: Replaces `\u0000` with spaces

---

### markupUtils.ts
**Apply inline markup tags from PDF annotations.**

`applyMarkupTags(markup, text)` - Wraps text with markup:
- Strikeout → `~~text~~`
- Underline → `__text__`
- Squiggly → `__text__` (same as underline)
- Highlight → `==text==`

These tags can be converted to markdown or other formats downstream.

---

## Data Flow

```
PageData (from PDF engine)
    │
    ▼
buildBbox() ─────────────────────────────┐
    │                                    │
    │  Converts TextItems to             │  Processes embedded
    │  ProjectionTextBox[]               │  images with OCR data
    │                                    │
    └────────────┬───────────────────────┘
                 │
                 ▼
    ProjectionTextBox[] (unified text boxes)
                 │
                 ▼
    projectPagesToGrid()
                 │
    ┌────────────┼────────────┐
    │            │            │
    ▼            ▼            ▼
Extract      Detect        Project
Anchors      Snapping      to Grid
    │            │            │
    └────────────┴────────────┘
                 │
                 ▼
    ParsedPage[] with reconstructed text
                 │
                 ▼
    cleanRawText() - Remove margins, cleanup
                 │
                 ▼
    Final text output
```

## Common Modifications

### Adjusting column detection sensitivity
Modify `roundAnchor()` in `gridProjection.ts` - currently rounds to nearest 1/4 unit.

### Changing OCR overlap threshold
Modify `OCR_OVERLAP_THRESHOLD` in `bbox.ts` (default: 0.5 = 50%).

### Adding new markup types
1. Add field to `MarkupData` in `src/core/types.ts`
2. Add case in `applyMarkupTags()` in `markupUtils.ts`

### Improving table detection
The current approach only handles bordered tables. To support borderless tables, you'd need to add layout analysis based on text alignment patterns in `tables.ts`.

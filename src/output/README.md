# src/output/

Output formatters that convert parsed document data into different formats.

## Files

### json.ts
**Structured JSON output formatter.**

**Functions:**

`buildJSON(pages)` - Builds structured JSON object:
```javascript
{
  pages: [{
    page: number,
    width: number,
    height: number,
    text: string,
    textItems: [{
      text: string,
      x, y, width, height: number,
      fontName: string,
      fontSize: number,
      confidence: number       // 1.0 for native PDF text, 0.0-1.0 for OCR
    }],
    boundingBoxes: BoundingBox[],
  }]
}
```

`formatJSON(result)` - Returns JSON string with 2-space indentation.

**Use Case:**
- When you need structured data for further processing
- Integration with other tools or pipelines
- Debugging text extraction issues

---

### text.ts
**Plain text output formatter.**

**Functions:**

`formatText(result)` - Formats all pages with headers:
```
--- Page 1 ---
[page 1 text]

--- Page 2 ---
[page 2 text]
```

`formatPageText(page)` - Returns single page text (no header).

**Use Case:**
- Human-readable output
- Piping to other tools (grep, awk, etc.)
- Quick document inspection

---

## Adding a New Output Format

1. Create new file in this directory (e.g., `markdown.ts`)
2. Export formatter function(s)
3. Add format to `OutputFormat` type in `src/core/types.ts`
4. Add case to switch in `src/core/parser.ts` `parse()` method
5. Add CLI option in `cli/parse.ts`

**Example: Adding Markdown format**
```typescript
// src/output/markdown.ts
export function formatMarkdown(result: ParseResult): string {
  return result.pages.map(page => {
    return `## Page ${page.pageNum}\n\n${page.text}`;
  }).join('\n\n---\n\n');
}
```

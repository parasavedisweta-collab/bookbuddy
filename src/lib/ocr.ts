import { createWorker, PSM } from "tesseract.js";

/**
 * One recognised line of text with geometry so callers can reason about
 * visual hierarchy (font size, position on the cover).
 */
export interface OcrLine {
  text: string;
  /** Bounding-box height — used as a proxy for font size. */
  height: number;
  top: number;
  bottom: number;
  confidence: number;
}

export interface OcrResult {
  text: string;
  confidence: number;
  lines: OcrLine[];
}

/**
 * Run OCR on a book cover image and return text plus per-line geometry.
 * Runs entirely client-side via Tesseract.js (open-source, no API key).
 *
 * Block output is requested explicitly; Tesseract v5+ only emits `text` by
 * default to save memory.
 *
 * @param sparseText  When true, uses PSM 11 (Sparse Text) which handles
 *   decorative/scattered lettering (e.g. large illustrated fonts on
 *   children's books) much better than the default AUTO mode.
 */
export async function extractTextFromImage(
  imageSource: string | File,
  { sparseText = false }: { sparseText?: boolean } = {}
): Promise<OcrResult> {
  const src =
    imageSource instanceof File
      ? URL.createObjectURL(imageSource)
      : imageSource;

  const worker = await createWorker("eng");
  try {
    if (sparseText) {
      // PSM 11 = SPARSE_TEXT: finds text in no particular order, ideal for
      // book covers where words are scattered across the image.
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    }
    const { data } = await worker.recognize(
      src,
      {},
      { text: true, blocks: true }
    );

    const lines: OcrLine[] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          const text = line.text.trim();
          if (!text) continue;
          lines.push({
            text,
            height: line.bbox.y1 - line.bbox.y0,
            top: line.bbox.y0,
            bottom: line.bbox.y1,
            confidence: line.confidence,
          });
        }
      }
    }

    return {
      text: data.text.trim(),
      confidence: data.confidence,
      lines,
    };
  } finally {
    await worker.terminate();
    if (imageSource instanceof File) {
      URL.revokeObjectURL(src);
    }
  }
}

/**
 * Marketing noise that routinely appears on covers but is neither title
 * nor author. Matched case-insensitively against whole lines.
 */
const BADGE_PATTERNS: RegExp[] = [
  /copies\s*sold/i,
  /million\s*copies/i,
  /\bbestsell(er|ing)\b/i,
  /new\s*york\s*times/i,
  /sunday\s*times/i,
  /international\s*bestseller/i,
  /oprah'?s?\s*book\s*club/i,
  /reese'?s?\s*book\s*club/i,
  /award[-\s]*winning/i,
  /winner\s*of/i,
  /pulitzer/i,
  /booker\s*prize/i,
  /newbery/i,
  /caldecott/i,
  /now\s*a\s*(major\s*)?(motion\s*picture|netflix|film|tv\s*series)/i,
  /^#\s*\d+/,
  /^[\d.,]+\s*(copies|million|years|weeks)\b/i,
];

/**
 * Common subtitle openers ("A FABLE ABOUT...", "A NOVEL", "THE STORY OF...").
 * These usually sit right under the title in medium-size type, so we don't
 * want them fighting for the title slot.
 *
 * `\s*` (not `\s+`) because OCR often merges the leading article with the
 * next word — e.g. the Alchemist cover reads "AFABLE ABOUT FOLLOWING…".
 */
const SUBTITLE_HINTS: RegExp[] = [
  /^a\s*(fable|novel|story|memoir|tale|guide|journey|history|biography|true\s+story)\b/i,
  /^an\s*(untold|unforgettable|epic|inspiring)\b/i,
  /^the\s+(story|tale|guide|journey|history|biography)\s+of\b/i,
];

function isBadge(text: string): boolean {
  return BADGE_PATTERNS.some((re) => re.test(text));
}

function isSubtitle(text: string): boolean {
  return SUBTITLE_HINTS.some((re) => re.test(text));
}

/**
 * Parse OCR output into a best-guess {title, author}.
 *
 * Strategy (much more reliable than "first line = title"):
 *   1. Drop lines that are clearly marketing badges or very low confidence.
 *   2. The title is the largest-font line(s). If multiple lines share ~the
 *      same large size, concatenate them top-to-bottom (handles covers that
 *      stack "THE" / "ALCHEMIST" on separate lines).
 *   3. The author is either an explicit "by X" line, or the bottom-most
 *      remaining line with a reasonable font size (ignoring subtitles).
 *
 * Accepts either an `OcrResult` (preferred — uses geometry) or a raw text
 * string (back-compat — falls back to line-order heuristics).
 */
export function parseBookText(input: string | OcrResult): {
  title: string;
  author: string;
} {
  const lines: OcrLine[] =
    typeof input === "string"
      ? input
          .split("\n")
          .map((t) => t.trim())
          .filter((t) => t.length > 1)
          .map((t, i) => ({
            text: t,
            // Synthetic height so first-line bias is preserved in fallback.
            height: 100 - i,
            top: i,
            bottom: i + 1,
            confidence: 100,
          }))
      : input.lines;

  if (lines.length === 0) return { title: "", author: "" };

  const clean = lines.filter(
    (l) => !isBadge(l.text) && l.confidence >= 40 && l.text.length >= 2
  );
  if (clean.length === 0) return { title: lines[0].text, author: "" };

  // Prefer non-subtitle lines for the title. If every readable line is a
  // subtitle (stylized cover where OCR couldn't read the real title), fall
  // back to the tallest line so we still show SOMETHING — the API lookup
  // will correct it later using the subtitle as a search query.
  const nonSubtitle = clean.filter((l) => !isSubtitle(l.text));
  const titlePool = nonSubtitle.length > 0 ? nonSubtitle : clean;

  const maxH = Math.max(...titlePool.map((l) => l.height));
  const titleLines = titlePool
    .filter((l) => l.height >= maxH * 0.75)
    .sort((a, b) => a.top - b.top);
  const title = titleLines
    .map((l) => l.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  // Pick author.
  let author = "";
  const byLine = clean.find(
    (l) => !titleLines.includes(l) && /\bby\s+\S+/i.test(l.text)
  );
  if (byLine) {
    author = byLine.text.replace(/^.*?\bby\s+/i, "").trim();
  } else {
    const candidates = clean
      .filter(
        (l) =>
          !titleLines.includes(l) &&
          !isSubtitle(l.text) &&
          l.height >= maxH * 0.2
      )
      .sort((a, b) => b.top - a.top); // prefer the bottom-most line
    author = candidates[0]?.text ?? "";
  }

  author = author.replace(/^["']+|["']+$/g, "").trim();
  return { title, author };
}

/**
 * Repair common OCR merges where the leading article fused with the next
 * word ("AFABLE" → "A FABLE", "ANOVEL" → "A NOVEL"). The Books APIs
 * fuzzy-match much better on split tokens.
 */
function unmergeArticles(text: string): string {
  return text
    .replace(
      /\ba(fable|novel|story|memoir|tale|guide|journey|history|biography)\b/gi,
      "a $1"
    )
    .replace(/\ban(untold|unforgettable|epic|inspiring)\b/gi, "an $1");
}

/**
 * Extract word-like tokens from a string — at least 4 characters long and
 * containing at least one vowel. This filters out the single-letter /
 * two-letter OCR fragments that stylized display fonts produce ("FA", "AD",
 * "pe", "EF", "SN" …) while keeping meaningful words like "Treasure",
 * "Fiveona", "Bljfon".
 */
function extractWordTokens(text: string): string[] {
  return text
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && /[aeiouAEIOU]/.test(t));
}

/**
 * Build a search query from OCR output. Strategy:
 *  1. Collect all non-badge lines with confidence ≥ 25, sorted best-first.
 *  2. Extract only word-like tokens (≥4 chars, contains vowel) to strip
 *     OCR noise from stylized/decorative fonts.
 *  3. Deduplicate and join.
 */
export function buildLookupQuery(result: OcrResult): string {
  const candidates = result.lines
    .filter((l) => !isBadge(l.text) && l.confidence >= 25 && l.text.length >= 2)
    .sort((a, b) => b.confidence - a.confidence);

  const raw =
    candidates.length > 0
      ? candidates.map((l) => l.text).join(" ")
      : result.text;

  const tokens = extractWordTokens(raw);
  // Deduplicate (case-insensitive) while preserving order
  const seen = new Set<string>();
  const unique = tokens.filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return unmergeArticles(unique.join(" "));
}

/**
 * Validates whether an image likely contains a book cover.
 *
 * A real book cover typically has:
 * - Multiple readable words (title is usually 2+ words)
 * - Reasonable OCR confidence (>50%)
 * - At least one line that looks like a title (3+ characters, not just noise)
 *
 * Returns { valid, reason } so the UI can show a helpful message.
 */
export function validateBookCover(
  text: string,
  confidence: number,
  lines?: OcrLine[]
): { valid: boolean; reason: string } {
  // Strip non-alphanumeric noise that OCR hallucinates on non-text images
  const cleaned = text.replace(/[^a-zA-Z0-9\s]/g, "").trim();
  const words = cleaned.split(/\s+/).filter((w) => w.length >= 2);

  // Use the best single-line confidence when available — stylized covers
  // often have many garbled lines but at least one clean one.
  const effectiveConfidence = lines && lines.length > 0
    ? Math.max(...lines.map((l) => l.confidence))
    : confidence;

  if (effectiveConfidence < 50) {
    return {
      valid: false,
      reason: "We couldn't read any clear text from this image. Please upload a photo of a book cover.",
    };
  }

  if (words.length < 2) {
    return {
      valid: false,
      reason: "That doesn't look like a book cover — we need to see the title clearly. Try again!",
    };
  }

  // Check that the longest "line" (likely the title) has at least 4 characters
  const textLines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const longestLine = textLines.reduce(
    (a, b) => (b.length > a.length ? b : a),
    ""
  );
  if (longestLine.length < 4) {
    return {
      valid: false,
      reason: "We can see some text but it doesn't look like a book title. Try a clearer photo!",
    };
  }

  return { valid: true, reason: "" };
}

/**
 * @deprecated Use validateBookCover() instead for better error messages.
 */
export function isLikelyBookCover(text: string, confidence: number): boolean {
  return validateBookCover(text, confidence).valid;
}

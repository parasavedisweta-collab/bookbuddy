import type { BookLookupResult } from "./types";

/**
 * Search Google Books API (free, no key required for basic queries).
 * Returns null on any failure; logs 429 rate-limit separately so callers
 * know to skip retrying for a while.
 */
async function searchGoogleBooks(
  query: string
): Promise<BookLookupResult | null> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1`
    );
    if (res.status === 429) {
      console.warn(
        "[bookLookup] Google Books rate-limited (429). Falling back to Open Library."
      );
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.items?.[0]?.volumeInfo;
    if (!item) return null;

    const title = item.title || query;
    const subtitle = item.subtitle || null;
    const author = item.authors?.join(", ") || "";
    // Google Books encodes series info in the title as "Title (Series #N)"
    let series: string | null = null;
    const seriesMatch = title.match(/\((.+?)(?:\s*#?\d+)?\)$/);
    if (seriesMatch) {
      series = seriesMatch[1].trim();
    }

    return {
      title,
      series,
      subtitle,
      author,
      genre: item.categories?.[0] || null,
      ageRange: item.maturityRating === "NOT_MATURE" ? "6-8" : "9-12",
      summary: item.description
        ? item.description.slice(0, 200) + "..."
        : null,
      coverUrl: item.imageLinks?.thumbnail?.replace("http:", "https:") || null,
      source: "google_books",
      haystack: [title, subtitle, author, (item.description || "").slice(0, 300)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch the best English edition of a work. Open Library's `search.json`
 * returns works whose canonical title is stored in the original language
 * (so Paulo Coelho's work comes back as "O Alquimista" even when the user
 * uploaded an English cover). Pulling the edition list lets us substitute
 * an English title and cover when one exists.
 */
async function fetchEnglishEdition(
  workKey: string
): Promise<{ title?: string; coverId?: number } | null> {
  try {
    const res = await fetch(
      `https://openlibrary.org${workKey}/editions.json?limit=50`
    );
    if (!res.ok) return null;
    const data = await res.json();
    type Edition = {
      title?: string;
      covers?: number[];
      languages?: { key?: string }[];
    };
    const entries: Edition[] = Array.isArray(data.entries) ? data.entries : [];
    const english = entries.find((e) =>
      e.languages?.some((l) => l?.key === "/languages/eng")
    );
    if (!english) return null;
    return {
      title: english.title,
      coverId: english.covers?.[0],
    };
  } catch {
    return null;
  }
}

/**
 * Search Open Library API (fully free, no key needed). Requests English
 * editions and, when the top hit's canonical title is in another language,
 * follows up to the editions endpoint to swap in the English title/cover.
 */
async function searchOpenLibrary(
  query: string
): Promise<BookLookupResult | null> {
  try {
    const res = await fetch(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&language=eng&limit=5`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const docs: unknown[] = Array.isArray(data.docs) ? data.docs : [];
    if (docs.length === 0) return null;

    type OpenLibDoc = {
      key?: string;
      title?: string;
      subtitle?: string;
      author_name?: string[];
      cover_i?: number;
      subject?: string[];
      first_sentence?: string[];
      language?: string[];
    };
    const typed = docs as OpenLibDoc[];
    const doc =
      typed.find((d) => d.language?.includes("eng")) ?? typed[0];

    let title = doc.title || query;
    let coverId = doc.cover_i;
    let workDescription: string | null = null;

    // Fetch English edition title/cover AND work description in parallel.
    if (doc.key) {
      const [eng, workData] = await Promise.all([
        fetchEnglishEdition(doc.key),
        fetch(`https://openlibrary.org${doc.key}.json`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (eng?.title) title = eng.title;
      if (eng?.coverId) coverId = eng.coverId;
      if (workData?.description) {
        const raw: string =
          typeof workData.description === "string"
            ? workData.description
            : (workData.description?.value ?? "");
        // Keep the first complete sentence for a tidy one-liner.
        const firstSentenceMatch = raw.match(/^(.+?[.!?])(\s|$)/);
        workDescription = firstSentenceMatch ? firstSentenceMatch[1] : raw.slice(0, 220);
      }
    }

    const subtitle = doc.subtitle || null;
    const author = doc.author_name?.join(", ") || "";
    const firstSentence = doc.first_sentence?.join(" ") || null;
    const summary = workDescription ?? firstSentence;
    // Open Library stores series in subject list as "series_name (Series)"
    const seriesSubject = doc.subject?.find((s: string) =>
      /\(series\)$/i.test(s)
    );
    const series = seriesSubject
      ? seriesSubject.replace(/\s*\(series\)$/i, "").trim()
      : null;
    return {
      title,
      series,
      subtitle,
      author,
      genre: doc.subject?.slice(0, 1)?.[0] || null,
      ageRange: null,
      summary,
      coverUrl: coverId
        ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
        : null,
      source: "open_library",
      haystack: [title, subtitle, author, firstSentence]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    };
  } catch {
    return null;
  }
}

/**
 * Simple in-memory cache of SUCCESSFUL lookups only. We deliberately don't
 * cache misses because Google Books' keyless rate limit (429) is transient
 * — we want subsequent scans to retry once the limit clears.
 */
const lookupCache = new Map<string, BookLookupResult>();

/**
 * Open Library title-specific search. Useful when a full-text query is too
 * noisy (garbled OCR from decorative fonts) — searching by title field is
 * more precise.
 */
async function searchOpenLibraryByTitle(
  titleTokens: string[]
): Promise<BookLookupResult | null> {
  const titleQuery = titleTokens.join(" ");
  try {
    const res = await fetch(
      `https://openlibrary.org/search.json?title=${encodeURIComponent(titleQuery)}&language=eng&limit=5`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const docs: unknown[] = Array.isArray(data.docs) ? data.docs : [];
    if (docs.length === 0) return null;
    // Re-use the same result-building logic by delegating to the full search
    // with the title query as a q param is equivalent enough here.
    return searchOpenLibrary(titleQuery);
  } catch {
    return null;
  }
}

/**
 * Look up book metadata. Tries Google Books first, falls back to Open
 * Library (full-text), then Open Library title-search with the longest
 * tokens only (better signal for noisy OCR queries). Successful results
 * are cached for the page lifetime.
 */
export async function lookupBook(
  query: string
): Promise<BookLookupResult | null> {
  const key = query.trim().toLowerCase();
  if (!key) return null;
  const cached = lookupCache.get(key);
  if (cached) return cached;

  const googleResult = await searchGoogleBooks(query);
  if (googleResult) {
    lookupCache.set(key, googleResult);
    return googleResult;
  }

  const openResult = await searchOpenLibrary(query);
  if (openResult) {
    lookupCache.set(key, openResult);
    return openResult;
  }

  // Both failed — retry Open Library with just the longest tokens from the
  // query, using the title field for more precision. Helps when the main
  // query contains lots of OCR noise alongside a few meaningful words.
  const longTokens = query
    .split(/\s+/)
    .filter((t) => t.length >= 5)
    .slice(0, 5);
  if (longTokens.length >= 2) {
    const titleResult = await searchOpenLibraryByTitle(longTokens);
    if (titleResult) {
      lookupCache.set(key, titleResult);
      return titleResult;
    }
  }

  return null;
}

/**
 * Convert a File or blob URL to a base64 data URI suitable for the Groq
 * vision API. Resizes to max 1024px on the longest side to stay within
 * token limits while preserving enough detail to read text.
 */
async function fileToBase64(imageSource: File | string): Promise<string> {
  const blob =
    imageSource instanceof File
      ? imageSource
      : await fetch(imageSource).then((r) => r.blob());

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const MAX = 1024;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        if (width > height) {
          height = Math.round((height * MAX) / width);
          width = MAX;
        } else {
          width = Math.round((width * MAX) / height);
          height = MAX;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      // Use JPEG at 85% quality — good text legibility, small payload
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Use Llama 4 Scout (Groq free tier) to identify a book directly from the
 * cover image. This is the PRIMARY identification path — it bypasses OCR
 * entirely and reads the image like a human, handling angles, lighting,
 * decorative fonts, and backgrounds that break Tesseract.
 *
 * The older OCR + text-LLM path (`extractBookInfoFromOcrLLM`) remains as
 * a fallback when the Groq key is not set or this call fails.
 *
 * Returns null if the key is missing, the model can't identify the book,
 * or the call fails.
 */
export async function identifyBookFromImage(
  imageSource: File | string
): Promise<{ title: string; author: string; series: string | null } | null> {
  const groqKey = process.env.NEXT_PUBLIC_GROQ_API_KEY;
  if (!groqKey) return null;

  try {
    const dataUri = await fileToBase64(imageSource);

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Look at this book cover image and identify the book.

Return JSON only: {"title":"...","author":"...","series":"..."}
- "title": the specific book title (e.g. "Five on a Treasure Island")
- "author": the author's full name as printed on the cover
- "series": the series name if this is part of a series (e.g. "The Famous Five"), otherwise null

Rules:
- Ignore marketing text ("BESTSELLER", "MILLION COPIES SOLD", "#1", award badges)
- "series" and "title" are different: series = "The Famous Five", title = "Five on a Treasure Island"
- If you cannot clearly identify the book, return {"title":"","author":"","series":null}
- Do NOT guess or hallucinate — only return a title/author you can actually see on the cover`,
              },
              {
                type: "image_url",
                image_url: { url: dataUri },
              },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 200,
      }),
    });

    if (!res.ok) {
      console.warn("[vision] Groq vision call failed:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    if (typeof parsed?.title !== "string" || typeof parsed?.author !== "string") {
      return null;
    }
    const result = {
      title: parsed.title.trim(),
      author: parsed.author.trim(),
      series: typeof parsed?.series === "string" ? parsed.series.trim() : null,
    };
    // Return null if the model said it couldn't identify
    if (!result.title) return null;
    return result;
  } catch (e) {
    console.warn("[vision] identifyBookFromImage error:", e);
    return null;
  }
}

/**
 * Use Groq (Llama 3.1 — Meta's open-source model, free hosted tier) to
 * extract {title, author} from raw OCR text when our heuristic + API
 * lookup have both failed. The LLM is good at ignoring marketing noise
 * ("65 MILLION COPIES SOLD", subtitle, blurbs) that trips up regex rules.
 *
 * Returns null if the key is missing or the call fails — caller should
 * fall back to whatever it already has.
 */
export async function extractBookInfoFromOcrLLM(
  ocrText: string
): Promise<{ title: string; author: string; series: string | null } | null> {
  const groqKey = process.env.NEXT_PUBLIC_GROQ_API_KEY;
  if (!groqKey) return null;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You identify books from messy OCR text of a book cover. OCR frequently garbles text on decorative fonts — use ALL clues and your training knowledge.

Key patterns:
- Large decorative fonts produce spaced-out or misread letters: "FA M AD" = FAMOUS, "F I \\ E pe" = FIVE, "Guid Bljfon" = Enid Blyton, "Pau o Coe ho" = Paulo Coelho. Read phonetically.
- A subtitle like "A FABLE ABOUT FOLLOWING YOUR DREAM" identifies The Alchemist by Paulo Coelho.
- "Fiveona Treasure ISland" with "Guid Bljfon" = Five on a Treasure Island by Enid Blyton.
- Ignore: marketing badges, symbols, isolated single characters.

CRITICAL RULES:
- Only identify a book if you see at least some recognisable text that phonetically or semantically maps to a real book title or author name.
- If the OCR text is pure symbols, numbers, and random letters with NO resemblance to any book title or author, return {"title":"","author":"","series":null} — do NOT guess or hallucinate.
- A confident identification requires at least one of: a readable title fragment, a readable author name fragment, or a distinctive subtitle/phrase.

Respond with JSON only: {"title":"...","author":"...","series":"..."}. "series" is the series name or null. If uncertain, return {"title":"","author":"","series":null}.`,
          },
          {
            role: "user",
            content: `OCR text from book cover:\n\n${ocrText}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 200,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    if (
      typeof parsed?.title !== "string" ||
      typeof parsed?.author !== "string"
    ) {
      return null;
    }
    return {
      title: parsed.title.trim(),
      author: parsed.author.trim(),
      series: typeof parsed?.series === "string" ? parsed.series.trim() : null,
    };
  } catch {
    return null;
  }
}

/**
 * Use Groq (Llama 3.1) to infer genre, age range, and summary when
 * metadata APIs don't provide enough info. Free tier: 30 req/min.
 */
export async function inferBookDetails(
  title: string,
  author: string
): Promise<{ genre: string; ageRange: string; summary: string; series: string | null } | null> {
  const groqKey = process.env.NEXT_PUBLIC_GROQ_API_KEY;
  if (!groqKey) return null;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'You help categorize children\'s books. Respond with JSON only: {"genre":"...","ageRange":"...","summary":"...","series":"..."}. Genre must be one of: Adventure, Fantasy, Science Fiction, Comics, Mystery, Horror, Biography, Science & Nature, History, Poetry, Fairy Tales, Mythology, Sports, Humor, Educational, Art & Craft, Puzzle & Activity, Religion & Spirituality, Self-Help, Other. Age range must be one of: Below 5, 6-8, 9-12, 12+. Summary should be 1 kid-friendly sentence. Series is the series name if this book belongs to one (e.g. "The Famous Five", "Harry Potter"), otherwise null.',
          },
          {
            role: "user",
            content: `Book: "${title}" by ${author}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 200,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch {
    return null;
  }
}

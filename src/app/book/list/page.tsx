"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import {
  extractTextFromImage,
  parseBookText,
  validateBookCover,
  buildLookupQuery,
} from "@/lib/ocr";
import { lookupBook, extractBookInfoFromOcrLLM, inferBookDetails, identifyBookFromImage } from "@/lib/bookLookup";
import { GENRES, AGE_RANGES, type Genre, type Book } from "@/lib/types";
import { saveListedBook, replaceLocalBookId } from "@/lib/userStore";
import { createBook } from "@/lib/supabase/books";
import { uploadBookCover } from "@/lib/supabase/storage";
import { listChildrenForCurrentParent } from "@/lib/supabase/children";
import { getCurrentUserId } from "@/lib/supabase/client";
import { getCurrentParent } from "@/lib/supabase/parents";

type Step = "scan" | "details" | "confirm";
/** How much to trust the auto-filled metadata. `high` is not shown in UI. */
type Confidence = "high" | "medium" | "low";
/**
 * Convert any browser-decodable image (AVIF, HEIC on supported devices,
 * etc.) into a JPEG File so Tesseract and Groq vision can handle it.
 * Throws if the browser can't decode the input.
 */
async function normalizeImage(file: File): Promise<File> {
  // Formats our pipeline already handles natively.
  const passthrough = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (passthrough.has(file.type)) return file;

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode_failed"));
      el.src = objectUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no_canvas_context");
    ctx.drawImage(img, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92)
    );
    if (!blob) throw new Error("encode_failed");

    const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], newName, { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
export default function ListBookPage() {
  const router = useRouter();
  // Two separate inputs so we can give each the right browser hint:
  //   cameraInputRef: has `capture="environment"` → iOS/Android opens
  //     the back camera directly.
  //   libraryInputRef: no capture attribute → opens photo library / file
  //     picker. Needed because on iOS Safari you can't have one input
  //     that offers both (capture forces camera-only, omitting it hides
  //     the camera entry on some OS versions).
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("scan");
  const [loading, setLoading] = useState(false);

  // Auth gate — listing a book requires both a session (createBook
  // RLS depends on auth.uid() being a child's parent) AND a completed
  // registration (we need a child row to attach the book to). Push
  // unauthenticated users to /auth/sign-in; push authenticated-but-
  // unregistered users to /auth/child-setup.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const uid = await getCurrentUserId();
      if (cancelled) return;
      if (!uid) {
        router.replace("/auth/sign-in");
        return;
      }
      const parent = await getCurrentParent();
      if (cancelled) return;
      if (!parent) {
        router.replace("/auth/child-setup");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const [loadingMessage, setLoadingMessage] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  // `listing` drives the List-This-Book button's own spinner/disabled state.
  // Separate from `loading` (which is for the scan pipeline) so an in-flight
  // scan on another step can never block the final save.
  const [listing, setListing] = useState(false);
  // Surfaced under the List button when both local + Supabase writes fail —
  // without this, any silent throw in handleConfirm looked like "the button
  // does nothing" to the user (see: phone localStorage quota exhaustion).
  const [listError, setListError] = useState<string | null>(null);

  // Scan state
  const [userPhoto, setUserPhoto] = useState<string | null>(null);
  // Persistent base64 version of the user photo (blob URLs die on reload)
  const [userPhotoBase64, setUserPhotoBase64] = useState<string | null>(null);

  // Details state
  const [title, setTitle] = useState("");
  const [series, setSeries] = useState("");
  const [author, setAuthor] = useState("");
  const [genre, setGenre] = useState<Genre>("Adventure");
  const [ageRange, setAgeRange] = useState("6-8");
  const [summary, setSummary] = useState("");
  const [apiCoverUrl, setApiCoverUrl] = useState<string | null>(null);
  const [selectedCover, setSelectedCover] = useState<"api" | "user_photo">("api");
  const [metadataWarning, setMetadataWarning] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<Confidence | null>(null);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset errors up front so we can show format errors here too
    setScanError(null);
    setMetadataWarning(null);
    setConfidence(null);

    let workingFile: File;
    try {
      workingFile = await normalizeImage(file);
    } catch {
      setScanError(
        "That image format isn't supported on this device. Please use a JPG, PNG, or WebP photo."
      );
      // Reset both inputs so the same file can be re-selected after an error.
      if (cameraInputRef.current) cameraInputRef.current.value = "";
      if (libraryInputRef.current) libraryInputRef.current.value = "";
      return;
    }

    // Show user photo preview (blob URL for fast display)
    const preview = URL.createObjectURL(workingFile);
    setUserPhoto(preview);
    setUserPhotoBase64(null);
    setLoading(true);

    // Convert to base64 immediately so it persists after page reload
    const reader = new FileReader();
    reader.onloadend = () => setUserPhotoBase64(reader.result as string);
    reader.readAsDataURL(workingFile);

    try {
      // Step 1a: Vision identification (Llama 4 Scout) + OCR run in parallel.
      // Vision directly reads the image like a human — handles angles, lighting,
      // decorative fonts. OCR is kept as a fallback path when Groq is not set.
      setLoadingMessage("Reading book cover...");
      const [visionResult, ocr] = await Promise.all([
        identifyBookFromImage(workingFile),
        extractTextFromImage(workingFile),
      ]);
      console.debug("[scan] vision result:", visionResult);

      // Step 1b: If vision identified the book, look it up immediately and
      // skip the entire OCR → heuristic → text-LLM pipeline.
      if (visionResult?.title) {
        setLoadingMessage("Looking up book details...");
        const visionQuery = `${visionResult.title} ${visionResult.author}`.trim();
        const visionMetadata = await lookupBook(visionQuery);
        console.debug("[scan] vision lookup result:", visionMetadata);

        // Did the lookup actually return the same book the vision model saw?
        // Critical guard: e.g. lookup for "Summer Stories Enid Blyton" sometimes
        // returns "Famous Five" (right author, totally wrong title) — we must
        // reject this instead of overwriting vision's correct title.
        const lookupMatchesVision = (meta: typeof visionMetadata): boolean => {
          if (!meta) return false;
          const visionTokens = new Set(
            visionResult.title
              .toLowerCase()
              .replace(/[^a-z0-9\s]/g, " ")
              .split(/\s+/)
              .filter((t) => t.length >= 4)
          );
          if (visionTokens.size === 0) return true;
          const metaTitleText = `${meta.title || ""} ${meta.subtitle || ""}`.toLowerCase();
          const matched = [...visionTokens].filter((t) => metaTitleText.includes(t)).length;
          return matched / visionTokens.size >= 0.5;
        };

        // Baseline: trust the vision model's identification
        setTitle(visionResult.title);
        setAuthor(visionResult.author);
        if (visionResult.series) setSeries(visionResult.series);

        const visionLookupOk = lookupMatchesVision(visionMetadata);

        if (visionMetadata && visionLookupOk) {
          // Safe to pull in everything from the lookup
          if (visionMetadata.title) setTitle(visionMetadata.title);
          if (visionMetadata.author) setAuthor(visionMetadata.author);
          if (visionMetadata.series) setSeries(visionMetadata.series);
          if (visionMetadata.genre) {
            const matched = GENRES.find(
              (g) => g.toLowerCase() === visionMetadata.genre!.toLowerCase()
            );
            if (matched) setGenre(matched);
          }
          if (visionMetadata.ageRange) setAgeRange(visionMetadata.ageRange);
          if (visionMetadata.summary) setSummary(visionMetadata.summary);
          if (visionMetadata.coverUrl) {
            setApiCoverUrl(visionMetadata.coverUrl);
            setSelectedCover("api");
          }
          setConfidence("high");
        } else if (visionMetadata && !visionLookupOk) {
          // Lookup returned the WRONG book. Keep vision's title/author, drop
          // the wrong cover/summary/genre entirely, and warn the user.
          console.debug(
            "[scan] vision lookup returned a different book — rejecting",
            { vision: visionResult, lookup: { title: visionMetadata.title, author: visionMetadata.author } }
          );
          setApiCoverUrl(null);
          setSelectedCover("user_photo");
          setConfidence("medium");
          setMetadataWarning(
            `We read this as "${visionResult.title}"${visionResult.author ? ` by ${visionResult.author}` : ""} from the cover, but couldn't find matching details in our database. Please review every field below.`
          );
        } else {
          // No lookup result at all — vision still gives us title/author
          setApiCoverUrl(null);
          setSelectedCover("user_photo");
          setConfidence("medium");
          setMetadataWarning(
            `We read this as "${visionResult.title}"${visionResult.author ? ` by ${visionResult.author}` : ""} from the cover. Please review the genre and summary below.`
          );
        }

        // Fill in any missing details (summary, series) via Groq.
        // IMPORTANT: use the TRUSTED title/author — if the lookup mismatched,
        // we must NOT pass the wrong book's title to Groq or we'll get a
        // summary for the wrong book.
        const trusted = visionLookupOk && visionMetadata;
        const finalTitle = trusted ? (visionMetadata.title || visionResult.title) : visionResult.title;
        const finalAuthor = trusted ? (visionMetadata.author || visionResult.author) : visionResult.author;
        const needGroq = !trusted || !visionMetadata?.summary || !visionMetadata?.series;
        if (needGroq && finalTitle) {
          setLoadingMessage("Filling in details...");
          const inferred = await inferBookDetails(finalTitle, finalAuthor);
          if (inferred) {
            if (inferred.summary) setSummary(inferred.summary);
            if (inferred.series) setSeries(inferred.series);
            if (inferred.genre) {
              const matched = GENRES.find(
                (g) => g.toLowerCase() === inferred.genre.toLowerCase()
              );
              if (matched) setGenre(matched);
            }
            if (inferred.ageRange) setAgeRange(inferred.ageRange);
          }
        }

        setStep("details");
        return;
      }

      // Vision not available or couldn't identify — fall back to OCR pipeline.
      // Step 1c: Sparse-text retry if OCR confidence is low
      let ocrResult = ocr;
      const maxLineConf = ocr.lines.length > 0
        ? Math.max(...ocr.lines.map((l) => l.confidence))
        : ocr.confidence;
      if (maxLineConf < 70) {
        setLoadingMessage("Enhancing cover reading...");
        const sparse = await extractTextFromImage(workingFile, { sparseText: true });
        const sparseMax = sparse.lines.length > 0
          ? Math.max(...sparse.lines.map((l) => l.confidence))
          : sparse.confidence;
        if (sparseMax > maxLineConf || sparse.lines.length > ocr.lines.length) {
          ocrResult = sparse;
        }
      }
      console.debug("[scan] OCR lines", ocrResult.lines, "raw:", ocrResult.text);
      // If vision returned null AND OCR produced only gibberish, bail out.
      // Prevents an empty/garbage query from matching a random popular book.
      const meaningfulLines = ocrResult.lines.filter(
        (l) => l.confidence >= 60 && /[A-Za-z]{4,}/.test(l.text)
      );
      if (!visionResult?.title && meaningfulLines.length === 0) {
        setScanError(
          "That doesn't look like a book cover. Try again with the front cover facing the camera."
        );
        // Keep the photo in state so the user can choose "Use this photo anyway"
        // from the error UI and proceed to the details form. Phone uploads
        // often fail OCR/vision (tilt, glare) even when the photo itself is
        // a legitimate cover — taking it away at this point forces a retry
        // loop that's impossible to escape if the device simply can't hit
        // the confidence threshold.
        setLoading(false);
        return;
      }
      // Step 2: Validate — is this actually a book cover?
      const validation = validateBookCover(ocrResult.text, ocrResult.confidence, ocrResult.lines);
      if (!validation.valid) {
        setScanError(validation.reason);
        // See above — keep the photo; the error UI offers an escape hatch.
        setLoading(false);
        return;
      }

      // Step 3: Parse title/author using font-size + badge-filter heuristic
      // Parse heuristically but DON'T pre-populate the form yet — wait until
      // we know whether the lookup/LLM confirms the book. Avoids showing
      // garbage OCR values when everything fails.
      let parsed = parseBookText(ocrResult);

      // Step 4: Look up metadata using a richer query
      setLoadingMessage("Looking up book details...");
      const richQuery = buildLookupQuery(ocrResult);
      console.debug("[scan] rich query:", richQuery);
      const fallbackQuery = `${parsed.title} ${parsed.author}`.trim();
      const queryToUse = (richQuery || fallbackQuery).trim();
      let metadata = queryToUse ? await lookupBook(queryToUse) : null;
      console.debug("[scan] lookup result:", metadata);

      // Swap ocr reference for the rest of the pipeline
      const ocrForMatch = ocrResult;

      // Compare API metadata against the FULL raw OCR text — not just the
      // parsed title, which might itself be a subtitle or misread. We
      // consider a result plausible if any significant OCR token (4+ chars)
      // appears anywhere in the API's title/subtitle/author/description.
      const plausibleMatch = (meta: typeof metadata): boolean => {
        if (!meta) return false;
        const ocrTokens = new Set(
          ocrForMatch.text
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((t) => t.length >= 4)
        );
        if (ocrTokens.size === 0) return true;
        const hay = meta.haystack || `${meta.title} ${meta.author}`.toLowerCase();
        const matched = [...ocrTokens].filter((t) => hay.includes(t)).length;
        return matched / ocrTokens.size >= 0.25;
      };

      // Step 5: If lookup gave nothing or a weak match, try an LLM
      // (Llama 3.1 via Groq — Meta's open-source model, free tier) to
      // re-extract title/author from the raw OCR, then retry lookup.
      // Silently skips when the key isn't configured.
      let matchLevel: "confident" | "unverified" | "none" = metadata
        ? plausibleMatch(metadata)
          ? "confident"
          : "unverified"
        : "none";

      if (matchLevel !== "confident") {
        setLoadingMessage("Cleaning up cover text...");
        const llm = await extractBookInfoFromOcrLLM(ocrForMatch.text);
        console.debug("[scan] LLM extract:", llm);
        if (llm && llm.title) {
          parsed = { title: llm.title, author: llm.author || parsed.author };
          setTitle(parsed.title);
          if (parsed.author) setAuthor(parsed.author);
          if (llm.series) setSeries(llm.series);

          setLoadingMessage("Looking up book details...");
          const retry = await lookupBook(
            `${parsed.title} ${parsed.author}`.trim()
          );
          console.debug("[scan] LLM-retry lookup:", retry);
          if (retry) {
            // The LLM already did the disambiguation — trust its retry result
            // unconditionally. The OCR was too garbled to match any haystack
            // (e.g. "AFABLE ABOUT FOLLOWING" → The Alchemist has zero token
            // overlap), so plausibleMatch would always reject it.
            metadata = retry;
            matchLevel = "confident";
          }
        } else {
          // LLM returned empty — it couldn't identify the book either.
          // Discard any weak lookup result we had; don't show wrong metadata.
          if (matchLevel === "unverified") {
            metadata = null;
            matchLevel = "none";
          }
        }
      }

      // Helper to apply metadata fields (shared by both match levels)
      const applyMetadata = (meta: typeof metadata) => {
        if (!meta) return;
        setTitle(meta.title || parsed.title);
        if (meta.series) setSeries(meta.series);
        setAuthor(meta.author || parsed.author);
        if (meta.genre) {
          const matchedGenre = GENRES.find(
            (g) => g.toLowerCase() === meta.genre!.toLowerCase()
          );
          if (matchedGenre) setGenre(matchedGenre);
        }
        if (meta.ageRange) setAgeRange(meta.ageRange);
        if (meta.summary) setSummary(meta.summary);
        if (meta.coverUrl) {
          setApiCoverUrl(meta.coverUrl);
          setSelectedCover("api");
        }
      };

      if (metadata && matchLevel === "confident") {
        applyMetadata(metadata);
        setConfidence("high");
      } else if (metadata) {
        applyMetadata(metadata);
        setConfidence("medium");
        setMetadataWarning(
          `We think this is "${metadata.title}"${metadata.author ? ` by ${metadata.author}` : ""} — please double-check every field below before listing.`
        );
      } else {
        // Nothing identified — clear any stale heuristic values
        setTitle("");
        setAuthor("");
        setSeries("");
        setConfidence("low");
        const hasReadableText = ocrForMatch.text
          .replace(/[^a-zA-Z]/g, " ")
          .split(/\s+/)
          .some((w) => w.length >= 4);
        setMetadataWarning(
          hasReadableText
            ? "We couldn't match this book to our database. Please fill in the details manually."
            : "We couldn't read this cover clearly. Try placing the book flat and taking the photo straight-on, then scan again."
        );
      }

      // If summary or series is still blank, ask Groq's Llama (open-source,
      // free tier) to fill them in. Silently skips if key isn't configured.
      const appliedTitle = metadata?.title || "";
      const appliedAuthor = metadata?.author || "";
      const needsInference = (!metadata?.summary || !metadata?.series) && appliedTitle;
      if (needsInference) {
        setLoadingMessage("Filling in details...");
        const inferred = await inferBookDetails(appliedTitle, appliedAuthor);
        if (inferred) {
          if (inferred.summary) setSummary(inferred.summary);
          if (inferred.genre) {
            const matchedGenre = GENRES.find(
              (g) => g.toLowerCase() === inferred.genre.toLowerCase()
            );
            if (matchedGenre) setGenre(matchedGenre);
          }
          if (inferred.ageRange) setAgeRange(inferred.ageRange);
          if (inferred.series) setSeries(inferred.series);
        }
      }

      setStep("details");
    } catch (err) {
      console.error("Scan error:", err);
      setScanError("Something went wrong reading that image. Please try again.");
      setUserPhoto(null);
    } finally {
      setLoading(false);
      setLoadingMessage("");
    }
  }

  function handleManualEntry() {
    setStep("details");
  }

  async function handleConfirm() {
    if (listing) return; // re-entrancy guard
    setListing(true);
    setListError(null);

    // Two independent writes. EITHER one succeeding is enough to advance
    // to the confirmation screen — we just need the book to exist somewhere
    // the user can see it on their shelf.
    //
    // Why wrapped separately:
    //   • `saveListedBook` embeds the photo base64 and can throw
    //     `QuotaExceededError` on Safari once localStorage (~5 MB) fills up
    //     after a few phone listings. Previously that threw synchronously
    //     out of the whole handler — `setStep("confirm")` never ran and the
    //     button looked dead on second/third listings.
    //   • The Supabase path can fail on flaky networks / RLS / missing
    //     children. It used to succeed-or-log, but the surrounding local
    //     throw meant neither path advanced the UI on quota exhaustion.
    let localBook: Book | null = null;
    let localErr: unknown = null;
    try {
      localBook = saveListedBook({
        title,
        author,
        series,
        genre,
        ageRange,
        summary,
        coverUrl: apiCoverUrl,
        userPhotoUrl: userPhotoBase64,
        selectedCover,
      });
    } catch (err) {
      localErr = err;
      console.error("[book-list] local save failed:", err);
      // Quota is the dominant real-world cause; retry once without the
      // photo. User loses the preview but keeps the book — far better than
      // being silently blocked. Once the cover is in Supabase Storage this
      // retry path goes away.
      try {
        localBook = saveListedBook({
          title,
          author,
          series,
          genre,
          ageRange,
          summary,
          coverUrl: apiCoverUrl,
          userPhotoUrl: null,
          selectedCover: selectedCover === "user_photo" && !apiCoverUrl
            ? "user_photo" // keep source; just no image this run
            : selectedCover,
        });
        localErr = null;
      } catch (retryErr) {
        console.error("[book-list] local save retry (no photo) failed:", retryErr);
        localErr = retryErr;
      }
    }

    // Supabase dual-write. See books.ts for the id/RLS model.
    let supabaseBook: Awaited<ReturnType<typeof createBook>> | null = null;
    let supabaseErr: unknown = null;
    try {
      const children = await listChildrenForCurrentParent();
      const child = children[0];
      if (!child) {
        console.warn(
          "[book-list] no Supabase child for current parent; skipping Supabase book insert. " +
            "User is likely on legacy localStorage-only data."
        );
      } else {
        // Resolve cover_url before insert. For API-sourced covers the
        // Open Library URL is ready to go. For user photos we upload
        // the base64 to the public book-covers bucket (migration 0010)
        // and store the returned public URL — that's what makes the
        // photo visible to other society members and the unauthenticated
        // /library browse, not just to the lister via localStorage.
        //
        // If the upload fails (network, missing bucket on a stale
        // environment, RLS rejection) we fall back to the legacy
        // behaviour: cover_url=null with the base64 still living in
        // localStorage. The lister's own shelf/home merge keeps showing
        // their photo, and the listing flow doesn't get blocked on a
        // Storage hiccup.
        const coverSource: "api" | "user" | null =
          selectedCover === "api"
            ? "api"
            : selectedCover === "user_photo"
              ? "user"
              : null;

        let coverUrl: string | null = null;
        if (coverSource === "api") {
          coverUrl = apiCoverUrl;
        } else if (coverSource === "user" && userPhotoBase64) {
          coverUrl = await uploadBookCover(userPhotoBase64);
          if (!coverUrl) {
            console.warn(
              "[book-list] cover upload failed; falling back to localStorage-only photo"
            );
          }
        }

        supabaseBook = await createBook({
          child_id: child.id,
          title,
          author,
          description: summary,
          category: genre,
          cover_url: coverUrl,
          cover_source: coverSource,
          metadata: {
            series: series || null,
            age_range: ageRange || null,
          },
        });
        if (!supabaseBook) {
          console.warn("[book-list] Supabase createBook returned null");
        } else if (localBook?.id) {
          // Re-key the local copy to the Supabase UUID so the shelf/home
          // merge treats them as a single book. Without this the user
          // sees one card for the localStorage id (with the base64 cover
          // preserved) and a second empty card for the Supabase UUID
          // (cover_url = null until Storage upload is wired).
          replaceLocalBookId(localBook.id, supabaseBook.id);
          // `saveListedBook` already fired bb_books_change synchronously,
          // but that was before this async insert completed. Fire again so
          // the Supabase-backed feed effects pick up the UUID-keyed row.
          window.dispatchEvent(new Event("bb_books_change"));
        }
      }
    } catch (err) {
      supabaseErr = err;
      console.error("[book-list] Supabase write failed:", err);
    }

    setListing(false);

    if (!localBook && !supabaseBook) {
      // Both writes failed — surface something actionable instead of the
      // button just going quiet. The most likely cause today is a local
      // quota exhaustion (localErr = QuotaExceededError) combined with the
      // user being unregistered in Supabase (no child row → no insert).
      const reason = (localErr as { name?: string } | null)?.name === "QuotaExceededError"
        ? "This device's local storage is full. Try removing some listed books and try again."
        : "Couldn't save this book. Check your connection and try again.";
      setListError(reason);
      // Intentionally don't advance — user has something to act on.
      return;
    }

    // At least one write succeeded — show confirmation. Supabase being the
    // authoritative cross-device store, a local-only save still counts as
    // "listed" for this device in the dual-write window.
    setStep("confirm");
  }

  function handleDone() {
    router.push("/shelf");
  }

  return (
    <main className="flex-1 w-full max-w-2xl mx-auto px-5 pb-28">
      {/* Nav */}
      <nav className="sticky top-0 z-40 py-4 bg-surface/80 backdrop-blur-md flex items-center gap-3">
        <button
          onClick={() => (step === "scan" ? router.back() : setStep("scan"))}
          className="text-primary"
        >
          <span className="material-symbols-outlined text-2xl">arrow_back</span>
        </button>
        <h1 className="text-lg font-headline font-bold text-on-surface">
          {step === "scan"
            ? "Scan Book Cover"
            : step === "details"
              ? "Book Details"
              : "Listed!"}
        </h1>
      </nav>

      {/* Step 1: Scan */}
      {step === "scan" && (
        <div className="space-y-8 pt-4">
          {/* Preview / loading area — tap either button below to change. */}
          <div
            className="w-full aspect-[3/4] max-w-xs mx-auto bg-surface-container-low rounded-xl border-2 border-dashed border-outline-variant/40 flex flex-col items-center justify-center overflow-hidden"
          >
            {loading ? (
              <div className="text-center">
                <div className="w-10 h-10 border-3 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                <p className="text-sm font-medium text-on-surface-variant">
                  {loadingMessage}
                </p>
              </div>
            ) : userPhoto ? (
              <img
                src={userPhoto}
                alt="Book cover"
                className="w-full h-full object-cover rounded-xl"
              />
            ) : (
              <>
                <span className="material-symbols-outlined text-5xl text-primary mb-3">
                  photo_camera
                </span>
                <p className="font-headline font-bold text-on-surface">
                  Add a book cover
                </p>
                <p className="text-sm text-on-surface-variant mt-1">
                  Point at the cover or choose from your library
                </p>
              </>
            )}
          </div>

          {/* Two buttons, two inputs. On iOS Safari (and most Androids)
              you cannot get a single input to offer BOTH "Take Photo" and
              "Photo Library" reliably: `capture` forces camera-only, and
              omitting it hides the camera entry. Splitting them into two
              buttons is the path that works everywhere. */}
          <div className="flex gap-3 max-w-xs mx-auto">
            <button
              onClick={() => cameraInputRef.current?.click()}
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-full bg-primary text-on-primary font-bold text-sm disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-lg">photo_camera</span>
              Take photo
            </button>
            <button
              onClick={() => libraryInputRef.current?.click()}
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-full bg-surface-container-high text-on-surface font-bold text-sm disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-lg">photo_library</span>
              Upload
            </button>
          </div>

          {/* Camera input: capture="environment" opens the back camera. */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileSelect}
            className="hidden"
          />
          {/* Library input: no capture → opens Photos / file picker.
              accept="image/*" (broad) so iOS doesn't silently filter out
              HEIC by MIME-type mismatch; normalizeImage handles conversion. */}
          <input
            ref={libraryInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="hidden"
          />

          {/* Scan error message.
              UX note: the AI pipeline regularly rejects stylised children's
              book covers (hand-drawn titles, decorative author fonts) even
              though the photo itself is perfect. Users have no way to know
              they're fighting an OCR limitation rather than a photo quality
              issue — so we lead with a big obvious "List it anyway" primary
              button and relegate the retry to a secondary link. Previous
              layout put both as equal-weight text links and users missed
              the escape hatch entirely (see Enid Blyton / Magic Faraway
              Tree cover rejection report). */}
          {scanError && (
            <div className="bg-error-container/10 border border-error/20 rounded-xl p-4 space-y-3">
              <div className="flex gap-3 items-start">
                <span className="material-symbols-outlined text-error text-xl shrink-0 mt-0.5">
                  error
                </span>
                <p className="text-sm font-medium text-on-surface flex-1">
                  {scanError}
                </p>
              </div>

              {/* Primary action: proceed with this photo + manual entry.
                  Only rendered when a photo is actually in state — both
                  failure modes above (invalid format / OCR rejection)
                  preserve userPhoto, so this is the common path. */}
              {userPhoto && (
                <button
                  onClick={() => {
                    setScanError(null);
                    setApiCoverUrl(null);
                    setSelectedCover("user_photo");
                    setConfidence("low");
                    setMetadataWarning(
                      "We couldn't read this cover automatically. Please fill in the title, author and other details below."
                    );
                    setStep("details");
                  }}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-full bg-primary text-on-primary font-bold text-sm"
                >
                  <span
                    className="material-symbols-outlined text-lg"
                    style={{ fontVariationSettings: "'FILL' 1" }}
                  >
                    arrow_forward
                  </span>
                  List this book anyway
                </button>
              )}

              {/* Secondary: try another photo. Camera is still one tap
                  away from the buttons above the error card. */}
              <button
                onClick={() => { setScanError(null); libraryInputRef.current?.click(); }}
                className="w-full text-center text-primary font-bold text-sm py-2"
              >
                Try a different photo instead
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step 2: Details */}
      {step === "details" && (
        <div className="space-y-6 pt-4">
          {/* Confidence chip — hidden when high-confidence, shown for medium (amber) / low (red) */}
          {confidence === "medium" && (
            <div className="bg-secondary-container/40 border border-secondary/30 rounded-xl px-4 py-3 flex gap-2 items-center">
              <span
                className="material-symbols-outlined text-secondary text-lg shrink-0"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                warning
              </span>
              <p className="text-sm font-bold text-secondary">
                Best guess — please verify
              </p>
            </div>  
          )}

          {confidence === "low" && (
            <div className="bg-error-container/20 border border-error/30 rounded-xl p-4 flex gap-3 items-start">
              <span
                className="material-symbols-outlined text-error text-xl shrink-0 mt-0.5"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                error
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold uppercase tracking-widest text-error mb-1">
                  Couldn&apos;t match — please review
                </p>
                <p className="text-sm text-on-surface leading-snug">
                  {metadataWarning ?? "We couldn't confidently read this cover. Please fill in the details yourself."}
                </p>
              </div>
            </div>
          )}

          {/* Cover selection */}
          {(apiCoverUrl || userPhoto) && (
            <div className="space-y-3">
              {/* Large preview of the selected cover */}
              <div className="flex justify-center">
                <div className="w-36 h-52 rounded-xl overflow-hidden shadow-lg bg-surface-container-low">
                  <img
                    src={selectedCover === "api" ? (apiCoverUrl ?? userPhoto ?? "") : (userPhoto ?? apiCoverUrl ?? "")}
                    alt="Selected cover"
                    className="w-full h-full object-cover"
                  />
                </div>
              </div>

              {/* Thumbnail strip — only shown when there's more than one option */}
              {apiCoverUrl && userPhoto && (
                <>
                  <label className="text-sm font-bold text-secondary uppercase tracking-wider">
                    Cover Image
                  </label>
                  <div className="flex gap-3 overflow-x-auto pt-1 pb-2 px-1">
                    <button
                      onClick={() => setSelectedCover("api")}
                      className={`shrink-0 w-20 h-28 rounded-lg overflow-hidden relative ${
                        selectedCover === "api"
                          ? "ring-4 ring-primary"
                          : "opacity-60 grayscale"
                      }`}
                    >
                      <img
                        src={apiCoverUrl}
                        alt="AI suggested cover"
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute bottom-0 inset-x-0 bg-primary/90 text-[9px] text-white py-0.5 font-bold text-center">
                        AI SUGGESTED
                      </div>
                      {selectedCover === "api" && (
                        <div className="absolute top-1.5 right-1.5 w-5 h-5 bg-primary rounded-full flex items-center justify-center shadow">
                          <span className="material-symbols-outlined text-white text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
                        </div>
                      )}
                    </button>
                    <button
                      onClick={() => setSelectedCover("user_photo")}
                      className={`shrink-0 w-20 h-28 rounded-lg overflow-hidden relative ${
                        selectedCover === "user_photo"
                          ? "ring-4 ring-primary"
                          : "opacity-60 grayscale"
                      }`}
                    >
                      <img
                        src={userPhoto}
                        alt="My photo"
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute bottom-0 inset-x-0 bg-secondary/90 text-[9px] text-white py-0.5 font-bold text-center uppercase">
                        My Photo
                      </div>
                      {selectedCover === "user_photo" && (
                        <div className="absolute top-1.5 right-1.5 w-5 h-5 bg-primary rounded-full flex items-center justify-center shadow">
                          <span className="material-symbols-outlined text-white text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
                        </div>
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Series */}
          {series && (
            <Input
              label="Series"
              value={series}
              onChange={(e) => setSeries(e.target.value)}
              placeholder="Series name (optional)"
            />
          )}

          {/* Title */}
          <Input
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Book title"
            required
          />

          {/* Author */}
          <Input
            label="Author"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Author name"
          />

          {/* Genre */}
          <div className="space-y-2">
            <label className="block text-secondary-dim font-headline font-semibold text-sm ml-1">
              Genre
            </label>
            <select
              value={genre}
              onChange={(e) => setGenre(e.target.value as Genre)}
              className="w-full bg-surface-container-high border-none rounded-lg px-5 py-4 text-on-surface font-semibold outline-none"
            >
              {GENRES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-primary font-bold uppercase tracking-wider ml-1">
              AI pre-selected
            </p>
          </div>

          {/* Age Range */}
          <div className="space-y-2">
            <label className="block text-secondary-dim font-headline font-semibold text-sm ml-1">
              Age Range
            </label>
            <select
              value={ageRange}
              onChange={(e) => setAgeRange(e.target.value)}
              className="w-full bg-surface-container-high border-none rounded-lg px-5 py-4 text-on-surface font-semibold outline-none"
            >
              {AGE_RANGES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>

          {/* Summary */}
          <div className="space-y-2">
            <label className="block text-secondary-dim font-headline font-semibold text-sm ml-1">
              AI Summary
            </label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="A 1-line kid-friendly summary of this book"
              rows={3}
              className="w-full bg-surface-container-high border-none rounded-lg px-5 py-4 text-on-surface placeholder:text-outline-variant focus:ring-2 focus:ring-primary-container outline-none resize-none"
            />
          </div>

          <Button fullWidth onClick={handleConfirm} disabled={!title || listing}>
            {listing ? (
              <>
                <span className="w-4 h-4 border-2 border-on-primary border-t-transparent rounded-full animate-spin" />
                Listing...
              </>
            ) : (
              <>
                <span
                  className="material-symbols-outlined"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  check_circle
                </span>
                List This Book
              </>
            )}
          </Button>
          {listError ? (
            <div className="bg-error-container/20 border border-error/30 rounded-xl p-3 flex gap-2 items-start">
              <span className="material-symbols-outlined text-error text-lg shrink-0 mt-0.5">
                error
              </span>
              <p className="text-sm text-on-surface flex-1">{listError}</p>
            </div>
          ) : (
            <p className="text-center text-xs text-on-surface-variant">
              Double-check details before listing
            </p>
          )}
        </div>
      )}

      {/* Step 3: Confirmation */}
      {step === "confirm" && (
        <div className="text-center pt-12 space-y-6">
          <div className="w-24 h-24 bg-primary-container rounded-full flex items-center justify-center mx-auto">
            <span
              className="material-symbols-outlined text-primary text-5xl"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              check_circle
            </span>
          </div>
          <div>
            <h2 className="text-2xl font-headline font-extrabold text-on-surface">
              Book Listed!
            </h2>
            <p className="text-on-surface-variant mt-2">
              <strong>&quot;{title}&quot;</strong> is now available in your
              society&apos;s library.
            </p>
          </div>
          <div className="space-y-3">
            <Button fullWidth onClick={() => { setStep("scan"); setTitle(""); setSeries(""); setAuthor(""); setSummary(""); setUserPhoto(null); setUserPhotoBase64(null); setApiCoverUrl(null); setConfidence(null); setMetadataWarning(null); }}>
              List another book
              <span className="material-symbols-outlined">add</span>
            </Button>
            <Button variant="outline" fullWidth onClick={handleDone}>
              Go to My Shelf
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}

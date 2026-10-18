"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthorCandidate, AuthorDataset, AuthorRecord, Book, LookupStatus, createAuthorId, booksFromDataset, booksFromGoodreads, emptyDataset, loadDataset, normalizeAuthorName } from "./author-data";
import { AUTHOR_LOOKUP_VERSION } from "./lookup-version";
import { clearStoredDataset, persistDataset, readDataset, readDatasetOrEmpty } from "./dataset-storage";
import { CountryStamp, countryDisplayNames } from "./components/CountryStamp";
import { Globe, isApproximateBirthplace } from "./components/Globe";

type LookupCandidate = {
  status: "resolved" | "unresolved" | "retryable_error" | "ambiguous";
  title?: string;
  description?: string;
  wikidataId?: string;
  place?: string;
  country?: string;
  lat?: number;
  lng?: number;
  sourceUrl?: string;
  wikipediaUrl?: string;
  unresolvedReason?: "missing_identity" | "missing_birthplace" | "missing_coordinates";
  candidates?: LookupCandidate[];
};

type Verification = { book: Book; candidates: LookupCandidate[] };
type VerificationUndo = Verification & { previousRecord?: AuthorRecord };
type AuthorSort = "first" | "last" | "country";
type BookSort = "title" | "author" | "country";
type BookSection = "map" | "stamps" | "books" | "index";
type StampSort = "books" | "country";
const FAILED_LOOKUP_RETRY_MS = 5 * 60 * 1000;

const demoBooks: Book[] = [
  { id: "demo:beloved", title: "Beloved", author: "Toni Morrison", authorKey: "demo:toni-morrison" },
  { id: "demo:remains", title: "The Remains of the Day", author: "Kazuo Ishiguro", authorKey: "demo:kazuo-ishiguro" },
  { id: "demo:yellow-sun", title: "Half of a Yellow Sun", author: "Chimamanda Ngozi Adichie", authorKey: "demo:chimamanda-ngozi-adichie" },
  { id: "demo:vegetarian", title: "The Vegetarian", author: "Han Kang", authorKey: "demo:han-kang" },
  { id: "demo:solitude", title: "One Hundred Years of Solitude", author: "Gabriel García Márquez", authorKey: "demo:gabriel-garcia-marquez" },
  { id: "demo:friend", title: "My Brilliant Friend", author: "Elena Ferrante", authorKey: "demo:elena-ferrante" },
];

function authorBooks(books: Book[]) {
  return books.flatMap((book) => [
    book,
    ...(book.additionalAuthors ?? []).filter((additional) => additional.role === "coauthor").map((additional) => ({
      ...book,
      author: additional.name,
      authorKey: additional.authorKey,
      goodreadsAuthorId: undefined,
      additionalAuthors: [],
    })),
  ]);
}

function normalizedAuthorKeys(name: string) {
  const keys = new Set([normalizeAuthorName(name)]);
  if (name.includes(",")) {
    const [last, first] = name.split(",", 2);
    keys.add(normalizeAuthorName(`${first} ${last}`));
  }
  return [...keys];
}

function firstNameSortKey(name: string) {
  if (!name.includes(",")) return normalizeAuthorName(name);
  const [last, first] = name.split(",", 2);
  return normalizeAuthorName(`${first} ${last}`);
}

function lastNameSortKey(name: string) {
  if (name.includes(",")) return normalizeAuthorName(name.split(",", 1)[0]);
  const parts = normalizeAuthorName(name).split(" ").filter(Boolean);
  const suffixes = new Set(["jr", "sr", "ii", "iii", "iv"]);
  if (parts.length > 1 && suffixes.has(parts.at(-1)!)) parts.pop();
  return parts.at(-1) ?? "";
}

function storedCandidates(candidates: LookupCandidate[]): AuthorCandidate[] {
  return candidates.map((candidate) => ({
    title: candidate.title,
    description: candidate.description,
    wikidataId: candidate.wikidataId,
    place: candidate.place,
    country: candidate.country,
    latitude: candidate.lat,
    longitude: candidate.lng,
    sourceUrl: candidate.sourceUrl,
    wikipediaUrl: candidate.wikipediaUrl,
  }));
}

function lookupCandidates(candidates: AuthorCandidate[]): LookupCandidate[] {
  return candidates.map((candidate) => ({
    status: candidate.place && candidate.latitude !== undefined && candidate.longitude !== undefined ? "resolved" : "unresolved",
    ...candidate,
    lat: candidate.latitude,
    lng: candidate.longitude,
  }));
}

function authorRecord(book: Book, lookup: LookupCandidate): AuthorRecord {
  const updatedAt = new Date().toISOString();
  return {
    id: book.authorKey,
    schemaVersion: 1,
    name: book.author,
    normalizedName: normalizeAuthorName(book.author),
    externalIds: { goodreads: book.goodreadsAuthorId, wikidata: lookup.wikidataId },
    fieldProvenance: {
      identity: { origin: "wikidata", status: "verified", updatedAt },
      ...(lookup.status === "resolved" ? { birthplace: { origin: "wikidata" as const, status: "verified" as const, updatedAt } } : {}),
    },
    birthplace: lookup.status === "resolved" && lookup.place && lookup.lat !== undefined && lookup.lng !== undefined ? {
      name: lookup.place,
      country: lookup.country,
      latitude: lookup.lat,
      longitude: lookup.lng,
    } : undefined,
    lookupStatus: lookup.status === "retryable_error" ? "failed" : lookup.status,
    identityStatus: lookup.wikidataId ? "identified" : "unresolved",
    locationStatus: lookup.unresolvedReason === "missing_identity"
      ? undefined
      : lookup.status === "resolved"
      ? "resolved"
      : lookup.unresolvedReason === "missing_coordinates" ? "missing_coordinates" : "missing_birthplace",
    lookupVersion: AUTHOR_LOOKUP_VERSION,
    aliases: [book.author],
    confidence: lookup.status === "resolved" ? 1 : 0,
    lookupError: lookup.status === "unresolved"
      ? lookup.unresolvedReason === "missing_identity"
        ? "No matching author record found"
        : lookup.unresolvedReason === "missing_coordinates" && lookup.place
        ? `Birthplace found (${lookup.place}), but no coordinates available`
        : "No birthplace with coordinates found"
      : undefined,
    reviewedBy: lookup.status === "resolved" ? "automatic" : undefined,
    sourceUrl: lookup.sourceUrl,
    wikipediaUrl: lookup.wikipediaUrl,
    source: "wikidata",
    updatedAt,
  };
}

function reviewRecord(book: Book, status: LookupStatus, candidates: LookupCandidate[] = [], error?: string): AuthorRecord {
  const updatedAt = new Date().toISOString();
  return {
    id: book.authorKey,
    schemaVersion: 1,
    name: book.author,
    normalizedName: normalizeAuthorName(book.author),
    aliases: [book.author],
    externalIds: { goodreads: book.goodreadsAuthorId },
    fieldProvenance: { identity: { origin: "wikidata", status: "verified", updatedAt } },
    lookupStatus: status,
    identityStatus: status === "ambiguous" || status === "deferred" ? "ambiguous" : "unresolved",
    locationStatus: status === "failed" ? "failed" : undefined,
    lookupVersion: AUTHOR_LOOKUP_VERSION,
    candidates: storedCandidates(candidates),
    lookupError: error,
    source: "wikidata",
    updatedAt,
  };
}

async function saveSharedAuthors(records: AuthorRecord[]) {
  const identified = records.filter((record) => record.birthplace || record.identityStatus === "identified" || record.externalIds.wikidata);
  if (!identified.length) return;
  try {
    for (let index = 0; index < identified.length; index += 75) {
      await fetch("/api/authors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authors: identified.slice(index, index + 75) }),
      });
    }
  } catch {
    // The browser dataset remains usable if shared persistence is unavailable.
  }
}

const saveSharedAuthor = (record: AuthorRecord) => saveSharedAuthors([record]);

export default function Home() {
  const [books, setBooks] = useState<Book[]>(demoBooks);
  const [dataset, setDataset] = useState<AuthorDataset>(emptyDataset());
  const [filename, setFilename] = useState("Demo library");
  const [isDragging, setIsDragging] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [hasImportedLibrary, setHasImportedLibrary] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isDatasetReady, setIsDatasetReady] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [verificationUndo, setVerificationUndo] = useState<VerificationUndo>();
  const [selectedAuthorIds, setSelectedAuthorIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "mapped" | "review">("mapped");
  const [sort, setSort] = useState<AuthorSort>("last");
  const [countryFilter, setCountryFilter] = useState<string>();
  const [page, setPage] = useState(1);
  const [bookSection, setBookSection] = useState<BookSection>("map");
  const [stampPage, setStampPage] = useState(1);
  const [stampSort, setStampSort] = useState<StampSort>("books");
  const [stampQuery, setStampQuery] = useState("");
  const [bookQuery, setBookQuery] = useState("");
  const [bookSort, setBookSort] = useState<BookSort>("title");
  const [bookPage, setBookPage] = useState(1);
  const [isAddBookOpen, setIsAddBookOpen] = useState(false);
  const [newBookTitle, setNewBookTitle] = useState("");
  const [newBookIsbn, setNewBookIsbn] = useState("");
  const [newBookAuthor, setNewBookAuthor] = useState("");
  const [addBookStep, setAddBookStep] = useState<"entry" | "confirm">("entry");
  const [newAuthorMatch, setNewAuthorMatch] = useState<LookupCandidate>();
  const [matchedExistingAuthorId, setMatchedExistingAuthorId] = useState<string>();
  const [isMatchingNewAuthor, setIsMatchingNewAuthor] = useState(false);
  const [isAuthorSearchActive, setIsAuthorSearchActive] = useState(false);
  const [, setReviewingAuthorKey] = useState<string>();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [manualPlace, setManualPlace] = useState("");
  const [manualCountry, setManualCountry] = useState("");
  const [manualLatitude, setManualLatitude] = useState("");
  const [manualLongitude, setManualLongitude] = useState("");
  const [detailAuthorKey, setDetailAuthorKey] = useState<string>();
  const [detailBookId, setDetailBookId] = useState<string>();
  const [storageError, setStorageError] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);
  const datasetFileRef = useRef<HTMLInputElement>(null);
  const lookupControllerRef = useRef<AbortController | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const saved = readDataset();
        const params = new URLSearchParams(window.location.search);
        const savedFilter = params.get("filter");
        const savedSort = params.get("sort");
        const savedSection = params.get("section");
        const savedStampSort = params.get("stampSort");
        const savedBookSort = params.get("bookSort");
        const savedQuery = params.get("q") ?? "";
        setQuery(savedSection === "authors" ? savedQuery : "");
        setBookQuery(savedSection === "books" ? savedQuery : "");
        setCountryFilter(params.get("country") ?? undefined);
        setFilter(savedFilter === "all" || savedFilter === "review" ? savedFilter : "mapped");
        setSort(savedSort === "first" || savedSort === "country" ? savedSort : "last");
        const savedPage = Math.max(1, Number(params.get("page")) || 1);
        setPage(savedSection === "authors" ? savedPage : 1);
        setBookPage(savedSection === "books" ? savedPage : 1);
        setBookSection(savedSection === "stamps" ? "stamps" : savedSection === "books" ? "books" : savedSection === "authors" ? "index" : "map");
        setStampPage(savedSection === "stamps" ? savedPage : 1);
        setStampSort(savedStampSort === "country" ? "country" : "books");
        setBookSort(savedBookSort === "author" || savedBookSort === "country" ? savedBookSort : "title");
        const restoredBooks = booksFromDataset(saved);
        setDataset(saved);
        if (restoredBooks.length) {
          setBooks(restoredBooks);
          setFilename(saved.activeFilename ?? "Saved library");
          setHasImportedLibrary(true);
          setIsImportOpen(false);
          const restoredAuthors = authorBooks(restoredBooks);
          setVerifications(restoredAuthors.flatMap((book) => {
            const record = saved.authors[book.authorKey];
            return record?.lookupStatus === "ambiguous" && record.candidates?.length
              ? [{ book, candidates: lookupCandidates(record.candidates) }]
              : [];
          }));
        } else setIsImportOpen(true);
      } catch {
        try {
          clearStoredDataset();
        } catch (error) {
          setStorageError(error instanceof Error ? error.message : "Your saved travelogue could not be reset.");
        }
      } finally {
        setIsDatasetReady(true);
      }
    });
  }, []);

  const storeDataset = useCallback((next: AuthorDataset) => {
    try {
      persistDataset(next);
      setStorageError(undefined);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Your latest changes could not be saved.");
    }
  }, []);

  const authorBookEntries = useMemo(() => authorBooks(books), [books]);
  const authors = useMemo(() => [...new Map(authorBookEntries.map((book) => [book.authorKey, book])).values()], [authorBookEntries]);
  const verificationBooks = verifications[0]
    ? [...new Set(authorBookEntries.filter((book) => book.authorKey === verifications[0].book.authorKey).map((book) => book.title))]
    : [];
  const bookCounts = useMemo(() => authorBookEntries.reduce((counts, book) => counts.set(book.authorKey, (counts.get(book.authorKey) ?? 0) + 1), new Map<string, number>()), [authorBookEntries]);
  const records = authors.map((author) => dataset.authors[author.authorKey]).filter(Boolean);
  const mapped = records.filter((record) => record.birthplace);
  const reviewCount = authors.filter((author) => {
    const record = dataset.authors[author.authorKey];
    return !record || !["resolved", "pending"].includes(record.lookupStatus);
  }).length;
  const selectedAuthors = selectedAuthorIds.map((id) => dataset.authors[id]).filter(Boolean);
  const detailAuthor = detailAuthorKey ? authors.find((author) => author.authorKey === detailAuthorKey) : undefined;
  const detailBook = detailBookId ? books.find((book) => book.id === detailBookId) : undefined;
  const detailBookRecord = detailBook ? dataset.books[detailBook.id] : undefined;
  const detailBookAuthorRecord = detailBook ? dataset.authors[detailBook.authorKey] : undefined;
  const detailBookGoodreadsId = detailBook ? detailBook.goodreadsBookId ?? detailBookRecord?.externalIds.goodreads : undefined;
  const detailRecord = detailAuthorKey ? dataset.authors[detailAuthorKey] : undefined;
  const detailBooks = detailAuthorKey
    ? [...new Set(authorBookEntries.filter((book) => book.authorKey === detailAuthorKey).map((book) => book.title))]
    : [];
  const selectedPlace = selectedAuthors[0]?.birthplace;
  const uniquePlaces = new Set(mapped.map((record) => `${record.birthplace!.latitude},${record.birthplace!.longitude}`)).size;
  const countryCounts = [...mapped.reduce((counts, record) => {
    const country = record.birthplace?.country;
    if (!country || country.toLowerCase() === "unknown") return counts;
    counts.set(country, (counts.get(country) ?? 0) + 1);
    return counts;
  }, new Map<string, number>())].sort((left, right) => right[1] - left[1]);
  const countryBookCounts = authors.reduce((counts, author) => {
    const country = dataset.authors[author.authorKey]?.birthplace?.country;
    if (!country || country.toLowerCase() === "unknown") return counts;
    counts.set(country, (counts.get(country) ?? 0) + (bookCounts.get(author.authorKey) ?? 0));
    return counts;
  }, new Map<string, number>());
  const sortedCountryCounts = [...countryCounts].filter(([country]) => {
    const search = stampQuery.trim().toLocaleLowerCase("en");
    return !search || country.toLocaleLowerCase("en").includes(search) || (countryDisplayNames[country] ?? "").toLocaleLowerCase("en").includes(search);
  }).sort((left, right) => stampSort === "country"
    ? left[0].localeCompare(right[0])
    : (countryBookCounts.get(right[0]) ?? 0) - (countryBookCounts.get(left[0]) ?? 0) || left[0].localeCompare(right[0]));
  const visibleAuthors = authors.filter((author) => {
    const record = dataset.authors[author.authorKey];
    const matchesQuery = author.author.toLowerCase().includes(query.toLowerCase())
      || record?.birthplace?.name.toLowerCase().includes(query.toLowerCase())
      || record?.birthplace?.country?.toLowerCase().includes(query.toLowerCase());
    const matchesFilter = filter === "all" || (filter === "mapped" ? Boolean(record?.birthplace) : (!record || !["resolved", "pending"].includes(record.lookupStatus)));
    const matchesCountry = !countryFilter || record?.birthplace?.country === countryFilter;
    return matchesQuery && matchesFilter && matchesCountry;
  }).sort((left, right) => {
    const leftRecord = dataset.authors[left.authorKey];
    const rightRecord = dataset.authors[right.authorKey];
    const leftKey = sort === "first" ? firstNameSortKey(left.author) : sort === "last" ? lastNameSortKey(left.author) : leftRecord?.birthplace?.country ?? "\uffff";
    const rightKey = sort === "first" ? firstNameSortKey(right.author) : sort === "last" ? lastNameSortKey(right.author) : rightRecord?.birthplace?.country ?? "\uffff";
    return leftKey.localeCompare(rightKey) || lastNameSortKey(left.author).localeCompare(lastNameSortKey(right.author));
  });
  const pageSize = 12;
  const pageCount = Math.max(1, Math.ceil(visibleAuthors.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pagedAuthors = visibleAuthors.slice((safePage - 1) * pageSize, safePage * pageSize);
  const stampsPerSpread = 12;
  const stampPageCount = Math.max(1, Math.ceil(sortedCountryCounts.length / stampsPerSpread));
  const safeStampPage = Math.min(stampPage, stampPageCount);
  const pagedCountries = sortedCountryCounts.slice((safeStampPage - 1) * stampsPerSpread, safeStampPage * stampsPerSpread);
  const visibleBooks = books.filter((book) => {
    const search = bookQuery.trim().toLocaleLowerCase("en");
    return !search || book.title.toLocaleLowerCase("en").includes(search) || book.author.toLocaleLowerCase("en").includes(search);
  }).sort((left, right) => {
    const leftCountry = dataset.authors[left.authorKey]?.birthplace?.country ?? "\uffff";
    const rightCountry = dataset.authors[right.authorKey]?.birthplace?.country ?? "\uffff";
    const leftKey = bookSort === "title" ? left.title : bookSort === "author" ? left.author : leftCountry;
    const rightKey = bookSort === "title" ? right.title : bookSort === "author" ? right.author : rightCountry;
    return leftKey.localeCompare(rightKey) || left.title.localeCompare(right.title);
  });
  const booksPerPage = 12;
  const bookPageCount = Math.max(1, Math.ceil(visibleBooks.length / booksPerPage));
  const safeBookPage = Math.min(bookPage, bookPageCount);
  const pagedBooks = visibleBooks.slice((safeBookPage - 1) * booksPerPage, safeBookPage * booksPerPage);
  const newAuthorSuggestions = newBookAuthor.trim()
    ? authors.filter((author) => author.author.toLocaleLowerCase("en").includes(newBookAuthor.trim().toLocaleLowerCase("en"))).slice(0, 6)
    : [];

  useEffect(() => {
    if (!isDatasetReady) return;
    const params = new URLSearchParams();
    if (bookSection === "index" && query) params.set("q", query);
    if (bookSection === "books" && bookQuery) params.set("q", bookQuery);
    if (bookSection === "index" && filter !== "mapped") params.set("filter", filter);
    if (bookSection === "index" && sort !== "last") params.set("sort", sort);
    if (bookSection === "index" && countryFilter) params.set("country", countryFilter);
    if (bookSection !== "map") params.set("section", bookSection === "index" ? "authors" : bookSection);
    if (bookSection === "index" && safePage > 1) params.set("page", String(safePage));
    if (bookSection === "books" && safeBookPage > 1) params.set("page", String(safeBookPage));
    if (bookSection === "stamps" && safeStampPage > 1) params.set("page", String(safeStampPage));
    if (bookSection === "stamps" && stampSort !== "books") params.set("stampSort", stampSort);
    if (bookSection === "books" && bookSort !== "title") params.set("bookSort", bookSort);
    window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
  }, [bookQuery, bookSection, bookSort, countryFilter, filter, isDatasetReady, query, safeBookPage, safePage, safeStampPage, sort, stampSort]);

  useEffect(() => {
    if (!isSettingsOpen) return;
    const closeSettings = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setIsSettingsOpen(false);
    };
    document.addEventListener("pointerdown", closeSettings);
    return () => document.removeEventListener("pointerdown", closeSettings);
  }, [isSettingsOpen]);

  const resolveAuthors = useCallback(async (nextAuthors: Book[]) => {
    lookupControllerRef.current?.abort();
    const controller = new AbortController();
    lookupControllerRef.current = controller;
    const finishLoading = () => {
      if (lookupControllerRef.current === controller) setIsLoading(false);
    };
    const pendingVerifications: Verification[] = [];
    const cached = (() => {
      try {
        return readDatasetOrEmpty();
      }
      catch { return emptyDataset(); }
    })() as AuthorDataset;

    const localAuthors = { ...cached.authors };
    try {
      const response = await fetch("/api/authors", { signal: controller.signal });
      if (response.ok) {
        const shared = await response.json() as { authors?: Record<string, AuthorRecord> };
        cached.authors = { ...(shared.authors ?? {}), ...cached.authors };
      }
      await saveSharedAuthors(Object.values(localAuthors));
    } catch {
      if (controller.signal.aborted) return;
    }

    const records = Object.values(cached.authors);
    const recordsByGoodreads = new Map(records.flatMap((record) => record.externalIds.goodreads ? [[record.externalIds.goodreads, record] as const] : []));
    const recordsByName = new Map<string, AuthorRecord>();
    for (const record of records) {
      for (const key of new Set([record.normalizedName, ...normalizedAuthorKeys(record.name), ...(record.aliases ?? []).flatMap(normalizedAuthorKeys)])) {
        recordsByName.set(key, record);
      }
    }

    const missingAuthors: Book[] = [];
    for (const author of nextAuthors) {
      const matchingRecord = cached.authors[author.authorKey]
        ?? (author.goodreadsAuthorId ? recordsByGoodreads.get(author.goodreadsAuthorId) : undefined)
        ?? normalizedAuthorKeys(author.author).map((key) => recordsByName.get(key)).find(Boolean);
      const failedAt = matchingRecord ? Date.parse(matchingRecord.updatedAt) : Number.NaN;
      const hasRawEntityPlace = Boolean(matchingRecord?.birthplace && /^Q\d+$/.test(matchingRecord.birthplace.name));
      const shouldRetry = matchingRecord
        && matchingRecord.reviewedBy !== "manual"
        && (hasRawEntityPlace || (matchingRecord.lookupStatus === "failed"
          && ((matchingRecord.lookupVersion ?? 0) < AUTHOR_LOOKUP_VERSION || !Number.isFinite(failedAt) || Date.now() - failedAt >= FAILED_LOOKUP_RETRY_MS)));
      if (!matchingRecord || shouldRetry) {
        missingAuthors.push(author);
        continue;
      }
      if (!cached.authors[author.authorKey]) {
        cached.authors[author.authorKey] = {
          ...matchingRecord,
          id: author.authorKey,
          name: author.author,
          aliases: [...new Set([...(matchingRecord.aliases ?? []), matchingRecord.name, author.author])],
          externalIds: { ...matchingRecord.externalIds, goodreads: author.goodreadsAuthorId ?? matchingRecord.externalIds.goodreads },
        };
      }
    }

    if (!missingAuthors.length) {
      storeDataset(cached);
      setDataset({ ...cached, authors: { ...cached.authors } });
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setSelectedAuthorIds([]);
    setProgress({ done: 0, total: missingAuthors.length });

    let nextAuthorIndex = 0;
    let completedLookups = 0;
    let nextRequestAt = Date.now();

    const waitForRequestSlot = async () => {
      const now = Date.now();
      const wait = Math.max(0, nextRequestAt - now);
      nextRequestAt = Math.max(now, nextRequestAt) + 400;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    };

    const lookupAuthor = async (author: Book) => {
      await waitForRequestSlot();
      if (controller.signal.aborted) return;
      try {
        const seededWikidataId = cached.authors[author.authorKey]?.externalIds.wikidata;
        let lookup: LookupCandidate | undefined;
        let lastError: Error | undefined;
        for (let attempt = 0; attempt < 3 && !controller.signal.aborted; attempt += 1) {
          try {
            const lookupUrl = `/api/author?name=${encodeURIComponent(author.author)}&title=${encodeURIComponent(author.title)}&v=${AUTHOR_LOOKUP_VERSION}${seededWikidataId ? `&wikidataId=${encodeURIComponent(seededWikidataId)}` : ""}`;
            const response = await fetch(lookupUrl, {
              cache: "no-store",
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
            });
            if (!response.ok) throw new Error(`Author lookup failed: ${response.status}`);
            const result = await response.json() as LookupCandidate;
            if (result.status !== "retryable_error") {
              lookup = result;
              break;
            }
            lastError = new Error("The lookup service was temporarily unavailable.");
          } catch (error) {
            if (controller.signal.aborted) throw error;
            lastError = error instanceof Error ? error : new Error("Lookup failed");
          }
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
        }
        if (!lookup) throw lastError ?? new Error("Lookup failed");
        if (lookup.status === "ambiguous") {
          const candidates = lookup.candidates ?? [];
          pendingVerifications.push({ book: author, candidates });
          cached.authors[author.authorKey] = reviewRecord(author, "ambiguous", candidates);
        } else if (lookup.status === "resolved" || lookup.status === "unresolved") {
          cached.authors[author.authorKey] = authorRecord(author, lookup);
          await saveSharedAuthor(cached.authors[author.authorKey]);
        } else cached.authors[author.authorKey] = reviewRecord(author, "failed", [], "The lookup service was temporarily unavailable.");
      } catch (error) {
        if (controller.signal.aborted) {
          finishLoading();
          return;
        }
        cached.authors[author.authorKey] = reviewRecord(author, "failed", [], error instanceof Error ? error.message : "Lookup failed");
      }
      storeDataset(cached);
      completedLookups += 1;
      setDataset({ ...cached, authors: { ...cached.authors } });
      setProgress({ done: completedLookups, total: missingAuthors.length });
    };

    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = nextAuthorIndex;
        nextAuthorIndex += 1;
        if (index >= missingAuthors.length) return;
        await lookupAuthor(missingAuthors[index]);
      }
    };

    await worker();
    if (controller.signal.aborted) {
      finishLoading();
      return;
    }
    storeDataset(cached);
    setDataset({ ...cached, authors: { ...cached.authors } });
    setVerifications((current) => {
      const existingKeys = new Set(current.map((item) => item.book.authorKey));
      return [...current, ...pendingVerifications.filter((item) => !existingKeys.has(item.book.authorKey))];
    });
    finishLoading();
  }, [storeDataset]);

  useEffect(() => {
    if (!isDatasetReady) return;
    const task = window.setTimeout(() => void resolveAuthors(authors), 0);
    return () => {
      window.clearTimeout(task);
      lookupControllerRef.current?.abort();
    };
  }, [authors, isDatasetReady, resolveAuthors]);

  const openAuthorDetail = (author: Book) => {
    setDetailAuthorKey(author.authorKey);
  };

  const exportDataset = () => {
    const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "author-atlas-dataset.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const importDataset = async (file?: File) => {
    if (!file) return;
    try {
      const importedDataset = loadDataset(await file.text());
      const importedBooks = booksFromDataset(importedDataset);
      storeDataset(importedDataset);
      setDataset(importedDataset);
      if (importedBooks.length) {
        setBooks(importedBooks);
        setHasImportedLibrary(true);
        setIsImportOpen(false);
      }
      setFilename(importedDataset.activeFilename ?? file.name);
      setVerifications(authorBooks(importedBooks).flatMap((book) => {
        const record = importedDataset.authors[book.authorKey];
        return record?.lookupStatus === "ambiguous" && record.candidates?.length ? [{ book, candidates: lookupCandidates(record.candidates) }] : [];
      }));
    } catch {
      window.alert("That file is not a valid Reading Travelogue dataset.");
    } finally {
      if (datasetFileRef.current) datasetFileRef.current.value = "";
    }
  };

  const clearDataset = () => {
    if (!window.confirm("Clear this browser’s saved library? Shared author data will be kept.")) return;
    try {
      clearStoredDataset();
      setStorageError(undefined);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Your saved travelogue could not be removed.");
      return;
    }
    setDataset(emptyDataset());
    setBooks(demoBooks);
    setFilename("Demo library");
    setHasImportedLibrary(false);
    setIsImportOpen(true);
    setVerifications([]);
    setQuery(""); setFilter("mapped"); setCountryFilter(undefined); setPage(1);
  };

  const loadFile = async (file?: File) => {
    if (!file) return;
    const imported = booksFromGoodreads(await file.text());
    if (!imported.length) {
      window.alert("No books on the ‘read’ shelf were found in that export.");
      return;
    }
    setBooks(imported);
    setHasImportedLibrary(true);
    setIsImportOpen(false);
    setDataset((current) => {
      const next = {
        ...current,
        books: { ...current.books },
        activeBookIds: imported.map((book) => book.id),
        activeFilename: file.name,
      };
      for (const book of imported) {
        const relatedAuthors = [
          { name: book.author, authorKey: book.authorKey, role: "primary" as const },
          ...(book.additionalAuthors ?? []),
        ];
        next.books[book.id] = {
          id: book.id,
          title: book.title,
          isbn: book.isbn,
          externalIds: { goodreads: book.goodreadsBookId },
          authorIds: relatedAuthors.map((author) => author.authorKey),
          authorNames: relatedAuthors.map((author) => author.name),
          authorRoles: relatedAuthors.map((author) => author.role),
        };
      }
      storeDataset(next);
      return next;
    });
    setFilename(file.name);
    if (fileRef.current) fileRef.current.value = "";
  };

  const verifyAuthor = (candidate?: LookupCandidate) => {
    const verification = verifications[0];
    if (!verification) return;
    setVerificationUndo({ ...verification, previousRecord: dataset.authors[verification.book.authorKey] });
    setDataset((current) => {
      const record = authorRecord(verification.book, candidate ?? { status: "unresolved" });
      record.reviewedAt = new Date().toISOString();
      record.reviewedBy = "manual";
      const next = {
        ...current,
        authors: {
          ...current.authors,
          [verification.book.authorKey]: record,
        },
      };
      storeDataset(next);
      void saveSharedAuthor(next.authors[verification.book.authorKey]);
      return next;
    });
    setVerifications((current) => current.slice(1));
  };

  const undoVerification = () => {
    if (!verificationUndo) return;
    setDataset((current) => {
      const authors = { ...current.authors };
      if (verificationUndo.previousRecord) authors[verificationUndo.book.authorKey] = verificationUndo.previousRecord;
      else delete authors[verificationUndo.book.authorKey];
      const next = { ...current, authors };
      storeDataset(next);
      return next;
    });
    setVerifications((current) => [
      { book: verificationUndo.book, candidates: verificationUndo.candidates },
      ...current.filter((item) => item.book.authorKey !== verificationUndo.book.authorKey),
    ]);
    setVerificationUndo(undefined);
  };

  const deferVerification = () => {
    const verification = verifications[0];
    if (!verification) return;
    setDataset((current) => {
      const next = { ...current, authors: { ...current.authors, [verification.book.authorKey]: reviewRecord(verification.book, "deferred", verification.candidates) } };
      storeDataset(next);
      return next;
    });
    setVerifications((current) => current.slice(1));
  };

  const deferAllVerifications = () => {
    if (!verifications.length) return;
    setDataset((current) => {
      const authors = { ...current.authors };
      for (const verification of verifications) {
        authors[verification.book.authorKey] = reviewRecord(verification.book, "deferred", verification.candidates);
      }
      const next = { ...current, authors };
      storeDataset(next);
      return next;
    });
    setVerifications([]);
  };

  const saveManualBirthplace = () => {
    const verification = verifications[0];
    const latitude = Number(manualLatitude);
    const longitude = Number(manualLongitude);
    if (!verification || !manualPlace.trim() || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;
    const now = new Date().toISOString();
    setDataset((current) => {
      const next = {
        ...current,
        authors: {
          ...current.authors,
          [verification.book.authorKey]: {
            ...reviewRecord(verification.book, "resolved"),
            birthplace: { name: manualPlace.trim(), country: manualCountry.trim() || undefined, latitude, longitude },
            fieldProvenance: {
              identity: { origin: "user" as const, status: "contributed" as const, updatedAt: now },
              birthplace: { origin: "user" as const, status: "contributed" as const, updatedAt: now },
            },
            source: "manual" as const,
            reviewedAt: now,
            reviewedBy: "manual" as const,
          },
        },
      };
      storeDataset(next);
      void saveSharedAuthor(next.authors[verification.book.authorKey]);
      return next;
    });
    setVerifications((current) => current.slice(1));
    setManualPlace(""); setManualCountry(""); setManualLatitude(""); setManualLongitude("");
  };

  const reviewAuthor = async (book: Book) => {
    setReviewingAuthorKey(book.authorKey);
    try {
      const response = await fetch(`/api/author?name=${encodeURIComponent(book.author)}&title=${encodeURIComponent(book.title)}&v=${AUTHOR_LOOKUP_VERSION}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Lookup failed");
      const lookup = await response.json();
      if (lookup.status === "ambiguous") {
        setDataset((current) => {
          const next = { ...current, authors: { ...current.authors, [book.authorKey]: reviewRecord(book, "ambiguous", lookup.candidates) } };
          storeDataset(next);
          return next;
        });
        setVerifications((current) => [
          { book, candidates: lookup.candidates },
          ...current.filter((item) => item.book.authorKey !== book.authorKey),
        ]);
      } else if (lookup.status === "resolved") {
        setDataset((current) => {
          const next = { ...current, authors: { ...current.authors, [book.authorKey]: authorRecord(book, lookup) } };
          storeDataset(next);
          void saveSharedAuthor(next.authors[book.authorKey]);
          return next;
        });
      } else {
        setDataset((current) => {
          const next = { ...current, authors: { ...current.authors, [book.authorKey]: reviewRecord(book, "unresolved") } };
          storeDataset(next);
          return next;
        });
        setVerifications((current) => [{ book, candidates: [] }, ...current.filter((item) => item.book.authorKey !== book.authorKey)]);
      }
    } catch {
      setDataset((current) => {
        const next = { ...current, authors: { ...current.authors, [book.authorKey]: reviewRecord(book, "failed", [], "Could not reach the lookup service.") } };
        storeDataset(next);
        return next;
      });
    } finally {
      setReviewingAuthorKey(undefined);
    }
  };

  const addManualBook = (candidate?: LookupCandidate, defer = false, forceNewAuthor = false) => {
    const title = newBookTitle.trim();
    const authorName = newBookAuthor.trim();
    if (!title || !authorName) return;
    const existingAuthor = forceNewAuthor ? undefined : authors.find((author) => author.authorKey === matchedExistingAuthorId)
      ?? (forceNewAuthor ? undefined : authors.find((author) => normalizeAuthorName(author.author) === normalizeAuthorName(authorName)));
    const authorId = existingAuthor?.authorKey ?? createAuthorId();
    const id = `manual:${crypto.randomUUID()}`;
    const book: Book = { id, title, author: existingAuthor?.author ?? authorName, authorKey: authorId, isbn: newBookIsbn.trim() || undefined };
    setDataset((current) => {
      const next: AuthorDataset = {
        ...current,
        books: {
          ...current.books,
          [id]: {
            id,
            title,
            isbn: book.isbn,
            externalIds: {},
            authorIds: [authorId],
            authorNames: [book.author],
            authorRoles: ["primary"],
          },
        },
        activeBookIds: [...current.activeBookIds, id],
        authors: { ...current.authors },
      };
      if (!existingAuthor && defer) next.authors[authorId] = reviewRecord(book, "deferred");
      else if (!existingAuthor && candidate) next.authors[authorId] = authorRecord(book, candidate);
      storeDataset(next);
      if (next.authors[authorId]?.birthplace) void saveSharedAuthor(next.authors[authorId]);
      return next;
    });
    setBooks((current) => [...current, book]);
    setHasImportedLibrary(true);
    setIsAddBookOpen(false);
    setNewBookTitle(""); setNewBookIsbn(""); setNewBookAuthor(""); setAddBookStep("entry"); setNewAuthorMatch(undefined); setMatchedExistingAuthorId(undefined);
  };

  const matchNewBookAuthor = async () => {
    if (!newBookTitle.trim() || !newBookAuthor.trim()) return;
    const existing = authors.find((author) => normalizeAuthorName(author.author) === normalizeAuthorName(newBookAuthor));
    if (existing) {
      const record = dataset.authors[existing.authorKey];
      setNewAuthorMatch({
        status: record?.birthplace ? "resolved" : "unresolved",
        title: existing.author,
        description: "Already in your travelogue",
        wikidataId: record?.externalIds.wikidata,
        place: record?.birthplace?.name,
        country: record?.birthplace?.country,
        lat: record?.birthplace?.latitude,
        lng: record?.birthplace?.longitude,
        sourceUrl: record?.sourceUrl,
        wikipediaUrl: record?.wikipediaUrl,
      });
      setMatchedExistingAuthorId(existing.authorKey);
      setAddBookStep("confirm");
      return;
    }
    setIsMatchingNewAuthor(true);
    setMatchedExistingAuthorId(undefined);
    try {
      const response = await fetch(`/api/author?name=${encodeURIComponent(newBookAuthor.trim())}&title=${encodeURIComponent(newBookTitle.trim())}&v=${AUTHOR_LOOKUP_VERSION}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Lookup failed");
      const result = await response.json();
      const match = result.status === "resolved" ? result : result.candidates?.[0];
      setNewAuthorMatch(match ? { ...match, status: match.place && match.lat !== undefined && match.lng !== undefined ? "resolved" : "unresolved" } : undefined);
      setAddBookStep("confirm");
    } catch {
      setNewAuthorMatch(undefined);
      setAddBookStep("confirm");
    } finally {
      setIsMatchingNewAuthor(false);
    }
  };

  const deleteBook = (book: Book) => {
    if (!window.confirm(`Remove “${book.title}” from your travelogue?`)) return;
    setDataset((current) => {
      const nextBooks = { ...current.books };
      delete nextBooks[book.id];
      const next = {
        ...current,
        books: nextBooks,
        activeBookIds: current.activeBookIds.filter((id) => id !== book.id),
      };
      storeDataset(next);
      return next;
    });
    setBooks((current) => current.filter((entry) => entry.id !== book.id));
    setDetailBookId(undefined);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void loadFile(event.dataTransfer.files[0]);
  };

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="My Reading Travelogue home">
          <span className="brand-mark">RT</span>
          <span>My Reading Travelogue</span>
        </a>
        <div className="settings-wrap" ref={settingsRef}>
          <button className="settings-button" aria-label="Data settings" aria-expanded={isSettingsOpen} onClick={() => setIsSettingsOpen((current) => !current)}><span className="settings-gear" aria-hidden="true" /></button>
          {isSettingsOpen && (
            <div className="settings-menu">
              <button onClick={() => { setIsImportOpen(true); setIsSettingsOpen(false); }}>Upload Goodreads CSV <span>↻</span></button>
              <button onClick={() => { exportDataset(); setIsSettingsOpen(false); }}>Export travelogue <span>↓</span></button>
              <button onClick={() => { datasetFileRef.current?.click(); setIsSettingsOpen(false); }}>Import travelogue <span>↑</span></button>
              <button className="danger" onClick={() => { clearDataset(); setIsSettingsOpen(false); }}>Remove data from this device</button>
            </div>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(event: ChangeEvent<HTMLInputElement>) => void loadFile(event.target.files?.[0])}
        />
        <input ref={datasetFileRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importDataset(event.target.files?.[0])} />
      </header>

      <div className="book-shell">
      <nav className="book-tabs" aria-label="Travelogue sections">
        {([['map', 'Map'], ['stamps', 'Stamps'], ['books', 'Books'], ['index', 'Authors']] as const).map(([section, label]) => (
          <button key={section} className={bookSection === section ? "active" : ""} aria-pressed={bookSection === section} onClick={() => setBookSection(section)}>{label}</button>
        ))}
      </nav>

      {bookSection === "map" && <section id="top" className="hero">
        <div className="map-spread">
        <div className="map-page map-copy-page"><div className="hero-copy">
          <h1>My reading<br /><em>travelogue.</em></h1>

          <div className="stats" aria-label="Library statistics">
            <div><strong>{books.length}</strong><span>books read</span></div>
            <div><strong>{authors.length}</strong><span>authors</span></div>
            <div><strong>{uniquePlaces}</strong><span>birthplaces</span></div>
            <div><strong>{countryCounts.length}</strong><span>countries</span></div>
          </div>

        </div></div>

        <div className="map-page map-globe-page"><div className="globe-wrap">
          {isLoading ? (
            <div className="globe-loading" role="status" aria-live="polite">
              <div className="processing-stamp" aria-hidden="true"><span>RT</span><b>IN REVIEW</b></div>
              <strong>Checking {progress.done} / {progress.total}</strong>
              <div className="processing-track" aria-hidden="true">
                <i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
            </div>
          ) : <Globe locations={mapped} onSelect={setSelectedAuthorIds} />}
          {!isLoading && <span className="drag-hint">Rotate · zoom · select a marker</span>}
          {!isLoading && <label className="globe-location-picker">Find an author
            <select value="" onChange={(event) => { if (event.target.value) setSelectedAuthorIds([event.target.value]); }}>
              <option value="">Choose…</option>
              {[...mapped].sort((left, right) => left.name.localeCompare(right.name)).map((author) => <option key={author.id} value={author.id}>{author.name} — {author.birthplace?.name}</option>)}
            </select>
          </label>}
          {!isLoading && selectedPlace && selectedAuthors.length > 0 && (
            <div className="selected-author">
              <button onClick={() => setSelectedAuthorIds([])} aria-label="Close author details">×</button>
              <span>{selectedAuthors.every(isApproximateBirthplace) ? "Country-level birthplace" : "Place of birth"}</span>
              <strong>{selectedAuthors.length > 1 ? `${selectedAuthors.length} authors` : selectedAuthors[0].name}</strong>
              {selectedAuthors.length > 1 && <ul>{selectedAuthors.map((author) => <li key={author.id}>{author.name}</li>)}</ul>}
              <p>{selectedPlace.name}{selectedPlace.country ? `, ${selectedPlace.country}` : ""}</p>
            </div>
          )}
        </div></div>
        </div>
      </section>}

      {bookSection === "stamps" && <section className="stamp-book" aria-label="Countries represented">
        <div className="passport-spread">
          <div className="stamp-spread-heading">
            <label className="search-box stamp-search"><span>⌕</span><input aria-label="Search countries" value={stampQuery} onChange={(event) => { setStampQuery(event.target.value); setStampPage(1); }} placeholder="Search countries" /></label>
            <div className="stamp-controls"><label className="sort-control">Sort
                <select value={stampSort} onChange={(event) => { setStampSort(event.target.value as StampSort); setStampPage(1); }}>
                  <option value="books">Number of books</option>
                  <option value="country">Country name</option>
                </select>
              </label></div>
          </div>
          {[pagedCountries.slice(0, 6), pagedCountries.slice(6, 12)].map((countries, leafIndex) => (
            <div className="passport-page" key={leafIndex}>
              <div className="stamp-grid">
                {countries.map(([country, count]) => (
                  <button className={`stamp-filter ${countryFilter === country ? "active" : ""}`} onClick={() => { setCountryFilter(country); setPage(1); setBookSection("index"); }} key={country}>
                    <span className="stamp-mark">
                      <CountryStamp country={country} compact />
                      <strong className="stamp-count"><b>{String(count).padStart(2, "0")}</b><small>authors</small></strong>
                    </span>
                    <span className="stamp-label">{countryDisplayNames[country] ?? country}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {!countryCounts.length && <p className="country-empty">Country records will appear after import.</p>}
        </div>
        <nav className="stamp-pagination" aria-label="Stamp pages">
          <button onClick={() => setStampPage((current) => Math.max(1, current - 1))} disabled={safeStampPage === 1}>← Previous</button>
          <button onClick={() => setStampPage((current) => Math.min(stampPageCount, current + 1))} disabled={safeStampPage === stampPageCount}>Next →</button>
        </nav>
      </section>}

      {bookSection === "books" && <section className="library-section books-section" aria-label="Books in your library">
        <div className="index-book-page books-book-page">
          <div className="library-tools">
            <label className="search-box">
              <span>⌕</span>
              <input aria-label="Search books" value={bookQuery} onChange={(event) => { setBookQuery(event.target.value); setBookPage(1); }} placeholder="Search title or author" />
            </label>
            <div className="index-controls">
              <label className="sort-control">Sort
                <select value={bookSort} onChange={(event) => { setBookSort(event.target.value as BookSort); setBookPage(1); }}>
                  <option value="title">Title</option>
                  <option value="author">Author</option>
                  <option value="country">Country</option>
                </select>
              </label>
              <button className="add-book-button" onClick={() => setIsAddBookOpen(true)}>+ Add book</button>
            </div>
          </div>
          <div className="book-log-spread">
            {[pagedBooks.slice(0, 6), pagedBooks.slice(6, 12)].map((pageBooks, pageIndex) => <div className="book-log" role="table" aria-label={`Reading log page ${pageIndex + 1}`} key={pageIndex}>
              <div className="book-log-head" role="row"><span role="columnheader">No.</span><span role="columnheader">Reading log</span><span /></div>
              {pageBooks.map((book, rowIndex) => {
                const record = dataset.authors[book.authorKey];
                return <div
                  className="book-log-row"
                  role="button"
                  tabIndex={0}
                  key={book.id}
                  onClick={() => setDetailBookId(book.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setDetailBookId(book.id);
                    }
                  }}
                >
                  <span className="book-entry-number" role="cell">{String((safeBookPage - 1) * booksPerPage + pageIndex * 6 + rowIndex + 1).padStart(3, "0")}</span>
                  <span className="book-entry" role="cell"><strong>{book.title}</strong><small>{book.author} · {record?.birthplace?.country ?? "Needs review"}</small></span>
                  <button className="detail-button" aria-label={`View ${book.title} details`} onClick={(event) => { event.stopPropagation(); setDetailBookId(book.id); }}>i</button>
                </div>;
              })}
              {!pageBooks.length && pageIndex === 0 && <div className="book-log-empty">No matching books.</div>}
            </div>)}
          </div>
          {visibleBooks.length > booksPerPage && <nav className="pagination" aria-label="Book pages">
            <button onClick={() => setBookPage((current) => Math.max(1, current - 1))} disabled={safeBookPage === 1}>← Previous</button>
            <button onClick={() => setBookPage((current) => Math.min(bookPageCount, current + 1))} disabled={safeBookPage === bookPageCount}>Next →</button>
          </nav>}
        </div>
      </section>}

      {bookSection === "index" && <section id="library" className="library-section">
        <div className="index-book-page">
        {isLoading && <div className="section-heading">
          <div className="section-actions">
            <div className="status-pill">
              <span className="pulse" />
              Finding {progress.done} / {progress.total}
            </div>
          </div>
        </div>}

        <div className="library-tools">
          <label className="search-box">
            <span>⌕</span>
            <input aria-label="Search authors" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search author, city, or country" />
          </label>
          <div className="index-controls">
            <label className="sort-control">Sort
              <select value={sort} onChange={(event) => { setSort(event.target.value as AuthorSort); setPage(1); }}>
                <option value="first">First name</option>
                <option value="last">Last name</option>
                <option value="country">Country</option>
              </select>
            </label>
            <div className="filter-group" aria-label="Filter authors">
              {(["mapped", "review", "all"] as const).map((option) => (
                <button key={option} aria-pressed={filter === option} className={filter === option ? "active" : ""} onClick={() => { setFilter(option); setPage(1); }}>
                  {option === "review" ? "unknown" : option} ({option === "all" ? authors.length : option === "mapped" ? mapped.length : reviewCount})
                </button>
              ))}
            </div>
          </div>
        </div>

        {countryFilter && <button className="active-country" onClick={() => { setCountryFilter(undefined); setPage(1); }}>Showing {countryFilter} ×</button>}

        <div className="book-log-spread author-log-spread">
          {[pagedAuthors.slice(0, 6), pagedAuthors.slice(6, 12)].map((pageAuthors, pageIndex) => <div className="book-log author-log" role="table" aria-label={`Author log page ${pageIndex + 1}`} key={pageIndex}>
            <div className="book-log-head" role="row"><span role="columnheader">No.</span><span role="columnheader">Author log</span><span /></div>
            {pageAuthors.map((author, rowIndex) => {
              const record = dataset.authors[author.authorKey];
              const count = bookCounts.get(author.authorKey) ?? 0;
              const statusCopy = record?.birthplace
                ? `${record.birthplace.name}${record.birthplace.country ? `, ${record.birthplace.country}` : ""}`
                : "Needs review";
              return <div
                className="book-log-row author-log-row"
                role="button"
                tabIndex={0}
                key={author.authorKey}
                onClick={() => openAuthorDetail(author)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openAuthorDetail(author);
                  }
                }}
              >
                <span className="book-entry-number">{String((safePage - 1) * pageSize + pageIndex * 6 + rowIndex + 1).padStart(3, "0")}</span>
                <span className="book-entry"><strong>{author.author}</strong><small>{statusCopy} · {count} {count === 1 ? "book" : "books"}</small></span>
                {!isLoading && <button className="detail-button" aria-label={`View ${author.author} details`} title="Author details" onClick={(event) => { event.stopPropagation(); openAuthorDetail(author); }}>i</button>}
              </div>;
            })}
            {!pageAuthors.length && pageIndex === 0 && <div className="book-log-empty">No matching authors.</div>}
          </div>)}
        </div>
        {visibleAuthors.length > pageSize && (
          <nav className="pagination" aria-label="Author pages">
            <button onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1}>← Previous</button>
            <button onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={safePage === pageCount}>Next →</button>
          </nav>
        )}
        </div>
      </section>}
      </div>

      {isImportOpen && (
        <div className="modal-backdrop import-backdrop" role="presentation">
          <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
            {hasImportedLibrary && <button className="modal-close" onClick={() => setIsImportOpen(false)} aria-label="Close import">×</button>}
            <span className="import-passport-mark" aria-hidden="true">RT</span>
            <h2 id="import-title">Import your library</h2>
            <p>Start with your Goodreads CSV. We’ll keep the library on this device and use author names for Wikidata birthplace lookups.</p>
            <div
              className={`drop-zone ${isDragging ? "is-dragging" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && fileRef.current?.click()}
            >
              <span className="upload-icon">CSV</span>
              <span><b>{filename === "Demo library" ? "Drop the file here or choose it from your device" : filename}</b><small>Goodreads CSV export</small></span>
            </div>
          </section>
        </div>
      )}

      {!isImportOpen && isAddBookOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="author-detail-modal add-book-modal" role="dialog" aria-modal="true" aria-labelledby="add-book-title">
            <button className="modal-close" onClick={() => { setIsAddBookOpen(false); setAddBookStep("entry"); setNewAuthorMatch(undefined); setMatchedExistingAuthorId(undefined); }} aria-label="Close add book">×</button>
            <p className="kicker">READING LOG</p>
            <h2 id="add-book-title">Add a book</h2>
            {addBookStep === "entry" ? <>
              <div className="add-book-fields">
                <label>Title<input autoFocus value={newBookTitle} onChange={(event) => setNewBookTitle(event.target.value)} /></label>
                <label>ISBN <span>optional</span><input value={newBookIsbn} onChange={(event) => setNewBookIsbn(event.target.value)} /></label>
                <label className="author-field">Author
                  <input value={newBookAuthor} onChange={(event) => { setNewBookAuthor(event.target.value); setIsAuthorSearchActive(Boolean(event.target.value.trim())); }} placeholder="Start typing a name" autoComplete="off" />
                  {isAuthorSearchActive && newAuthorSuggestions.length > 0 && <span className="author-suggestions">{newAuthorSuggestions.map((author) => <button type="button" key={author.authorKey} onClick={() => { setNewBookAuthor(author.author); setIsAuthorSearchActive(false); }}>{author.author}<small>{dataset.authors[author.authorKey]?.birthplace?.country ?? "Needs review"}</small></button>)}</span>}
                </label>
              </div>
              <div className="detail-actions add-book-actions">
                <button className="none-button" onClick={() => { setIsAddBookOpen(false); setAddBookStep("entry"); setNewAuthorMatch(undefined); setMatchedExistingAuthorId(undefined); }}>Cancel</button>
                <button onClick={() => void matchNewBookAuthor()} disabled={!newBookTitle.trim() || !newBookAuthor.trim() || isMatchingNewAuthor}>{isMatchingNewAuthor ? "Matching…" : "Continue"}</button>
              </div>
            </> : <>
              <div className="author-match-card">
                <span>{newAuthorMatch ? "Best match" : "No confident match"}</span>
                <strong>{newAuthorMatch?.title ?? newBookAuthor}</strong>
                {newAuthorMatch?.description && <p>{newAuthorMatch.description}</p>}
                <b>{newAuthorMatch?.place ? `${newAuthorMatch.place}${newAuthorMatch.country ? `, ${newAuthorMatch.country}` : ""}` : "Birthplace unavailable"}</b>
                {newAuthorMatch?.wikipediaUrl && <a href={newAuthorMatch.wikipediaUrl} target="_blank" rel="noreferrer">Check Wikipedia ↗</a>}
              </div>
              <p className="match-question">{newAuthorMatch ? "Is this the right author?" : "You can edit the author name and try again, or add the book for later review."}</p>
              <div className="match-actions">
                <button className="none-button" onClick={() => { setAddBookStep("entry"); setNewAuthorMatch(undefined); setMatchedExistingAuthorId(undefined); }}>Edit</button>
                <button className="none-button" onClick={() => addManualBook(undefined, true)}>Skip for now</button>
                {matchedExistingAuthorId && <button className="none-button" onClick={() => addManualBook(newAuthorMatch, false, true)}>Add as new author</button>}
                {newAuthorMatch && <button className="confirm-match-button" onClick={() => addManualBook(newAuthorMatch)}>Yes, add book</button>}
              </div>
            </>}
          </section>
        </div>
      )}

      {!isImportOpen && !isAddBookOpen && detailBook && (
        <div className="modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setDetailBookId(undefined); }}>
          <section className="author-detail-modal book-detail-modal" role="dialog" aria-modal="true" aria-labelledby="book-detail-title">
            <button className="modal-close" onClick={() => setDetailBookId(undefined)} aria-label="Close book details">×</button>
            <p className="kicker">BOOK RECORD</p>
            <h2 id="book-detail-title">{detailBook.title}</h2>
            <div className="book-record-details">
              <div><span>Author</span><strong>{detailBook.author}</strong></div>
              <div><span>Origin</span><strong>{detailBookAuthorRecord?.birthplace?.country ?? "Needs review"}</strong></div>
              <div><span>ISBN</span><strong>{detailBook.isbn ?? "Not recorded"}</strong></div>
            </div>
            <div className="detail-links book-detail-links">
              {detailBookGoodreadsId && <a href={`https://www.goodreads.com/book/show/${detailBookGoodreadsId}`} target="_blank" rel="noreferrer">View on Goodreads ↗</a>}
              <button onClick={() => { setDetailBookId(undefined); openAuthorDetail(detailBook); }}>View author record →</button>
            </div>
            <div className="book-detail-danger">
              <button onClick={() => deleteBook(detailBook)}>Remove book from travelogue</button>
            </div>
          </section>
        </div>
      )}

      {!isImportOpen && !isAddBookOpen && !detailBook && detailAuthor && (
        <div className="modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setDetailAuthorKey(undefined); }}>
          <section className="author-detail-modal" role="dialog" aria-modal="true" aria-labelledby="author-detail-title">
            <button className="modal-close" onClick={() => setDetailAuthorKey(undefined)} aria-label="Close author details">×</button>
            <p className="kicker">AUTHOR RECORD</p>
            <h2 id="author-detail-title">{detailAuthor.author}</h2>
            <div className="detail-summary">
              <span>{detailBooks.length} {detailBooks.length === 1 ? "book" : "books"} in your library</span>
              <ul>{detailBooks.map((title) => <li key={title}>{title}</li>)}</ul>
            </div>
            <div className="detail-provenance">
              <div><span>Source</span><strong>{detailRecord?.source === "manual" ? "Manually entered" : detailRecord?.wikipediaUrl ? "Wikidata + Wikipedia" : "Wikidata"}</strong></div>
              <div><span>Last checked</span><strong>{detailRecord?.updatedAt ? new Date(detailRecord.updatedAt).toLocaleDateString() : "Not checked"}</strong></div>
              <div><span>Status</span><strong>{detailRecord?.birthplace ? "Mapped" : detailRecord?.reviewedBy === "manual" ? "Marked unknown" : "Needs review"}</strong></div>
            </div>
            {(detailRecord?.sourceUrl || detailRecord?.wikipediaUrl) && <div className="detail-links">
              {detailRecord.wikipediaUrl && <a href={detailRecord.wikipediaUrl} target="_blank" rel="noreferrer">Wikipedia ↗</a>}
              {detailRecord.sourceUrl && <a href={detailRecord.sourceUrl} target="_blank" rel="noreferrer">Wikidata ↗</a>}
            </div>}
            <div className="detail-actions">
              <button className="none-button" onClick={() => { setDetailAuthorKey(undefined); void reviewAuthor(detailAuthor); }}>Check sources again</button>
            </div>
          </section>
        </div>
      )}

      {!isImportOpen && !isAddBookOpen && !detailBook && !detailAuthor && verifications[0] && (
        <div className="modal-backdrop" role="presentation">
          <section className="verify-modal" role="dialog" aria-modal="true" aria-labelledby="verify-title" onKeyDown={(event) => {
            if (event.key === "Escape") deferVerification();
            if (event.key === "Tab") {
              const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), summary")];
              const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
              const nextIndex = event.shiftKey ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1) : (currentIndex >= focusable.length - 1 ? 0 : currentIndex + 1);
              event.preventDefault();
              focusable[nextIndex]?.focus();
            }
          }}>
            <button className="modal-close" onClick={deferVerification} aria-label="Close and review later" autoFocus>×</button>
            <p className="kicker">VERIFY AUTHOR</p>
            <h2 id="verify-title">Which {verifications[0].book.author}?</h2>
            <p className="verify-copy">{verifications[0].candidates.length ? "Check each writer on Wikipedia, then choose the matching record." : "No confident match was found. You can search Wikipedia or enter the birthplace yourself."}</p>
            <div className="verification-books">
              <span>In your library</span>
              <ul>{verificationBooks.map((title) => <li key={title}>{title}</li>)}</ul>
            </div>
            <div className="candidate-list">
              {verifications[0].candidates.map((candidate) => {
                return (
                  <div key={candidate.wikidataId ?? candidate.title} className="candidate">
                    <button onClick={() => verifyAuthor(candidate)}>
                      <span><strong>{candidate.title}</strong><small>{candidate.description ?? "Author record"}</small></span>
                      <span>{candidate.place ? `${candidate.place}${candidate.country ? `, ${candidate.country}` : ""}` : "Birthplace unavailable"}</span>
                    </button>
                    {candidate.wikipediaUrl
                      ? <a href={candidate.wikipediaUrl} target="_blank" rel="noreferrer">View Wikipedia ↗</a>
                      : <span className="no-wikipedia">No English Wikipedia page</span>}
                  </div>
                );
              })}
            </div>
            <details className="manual-entry">
              <summary>Enter birthplace manually</summary>
              <div><label>City or place<input value={manualPlace} onChange={(event) => setManualPlace(event.target.value)} /></label><label>Country<input value={manualCountry} onChange={(event) => setManualCountry(event.target.value)} /></label></div>
              <div><label>Latitude<input inputMode="decimal" value={manualLatitude} onChange={(event) => setManualLatitude(event.target.value)} /></label><label>Longitude<input inputMode="decimal" value={manualLongitude} onChange={(event) => setManualLongitude(event.target.value)} /></label></div>
              <button onClick={saveManualBirthplace} disabled={!manualPlace.trim() || !manualLatitude.trim() || !manualLongitude.trim()}>Save birthplace</button>
            </details>
            <div className="review-actions">
              <button className="none-button" onClick={() => verifyAuthor()}>Birthplace unknown</button>
              {verificationUndo && <button className="undo-review-button" onClick={undoVerification}>Undo last choice</button>}
              <button className="none-button" onClick={deferVerification} title="Skip this author for now">Review later</button>
              {verifications.length > 1 && <button className="none-button" onClick={deferAllVerifications} title="Close verification and leave all remaining authors for later">Skip all</button>}
            </div>
          </section>
        </div>
      )}
      {verificationUndo && !verifications[0] && (
        <div className="undo-toast" role="status">
          <span>Saved {verificationUndo.book.author}</span>
          <button onClick={undoVerification}>Undo</button>
          <button className="undo-dismiss" onClick={() => setVerificationUndo(undefined)} aria-label="Dismiss">×</button>
        </div>
      )}
      {storageError && (
        <div className="undo-toast storage-error" role="alert">
          <span>{storageError} Export your travelogue to avoid losing changes.</span>
          <button className="undo-dismiss" onClick={() => setStorageError(undefined)} aria-label="Dismiss">×</button>
        </div>
      )}
    </main>
  );
}

import { NextRequest, NextResponse } from "next/server";
import { normalizeResolverText as normalizeName, plainWikipediaValue, selectCandidate } from "../../author-resolver";
import { AUTHOR_LOOKUP_VERSION } from "../../lookup-version";
import { readLookupCache, saveLookupCache } from "../../lookup-cache-store";

type Binding = Record<string, { value: string } | undefined>;

const headers = {
  Accept: "application/sparql-results+json",
  "User-Agent": "YourReadingPassport/0.1 (local Goodreads visualization)",
};

const CACHE_TTL = 1000 * 60 * 60 * 24 * 30;
let nextWikimediaRequestAt = 0;

async function wikimediaFetch(url: URL) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = Date.now();
    const wait = Math.max(0, nextWikimediaRequestAt - now);
    nextWikimediaRequestAt = Math.max(now, nextWikimediaRequestAt) + 350;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(9_000) });
    if (response.status !== 429 || attempt === 2) return response;
    const retryAfter = Math.min(Number(response.headers.get("Retry-After") ?? 2), 10);
    nextWikimediaRequestAt = Math.max(nextWikimediaRequestAt, Date.now() + retryAfter * 1000);
  }
  throw new Error("Wikimedia request failed");
}

function sparqlString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}

function nameVariants(value: string) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  const variants = new Set([cleaned]);
  if (cleaned.includes(",")) {
    const [last, first] = cleaned.split(",", 2);
    variants.add(`${first.trim()} ${last.trim()}`);
  }
  return [...variants];
}

function titleVariants(value: string) {
  const trimmed = value.trim();
  const withoutSeries = trimmed.replace(/\s*[\[(].*?[\])]\s*$/, "").trim();
  const withoutSubtitle = withoutSeries.split(/:\s+/, 1)[0].trim();
  return [...new Set([trimmed, withoutSeries, withoutSubtitle].filter(Boolean))];
}

function normalizedBookPhrases(title: string) {
  return titleVariants(title)
    .map((variant) => normalizeName(variant))
    .filter((variant) => variant.length >= 6);
}

async function wikipediaBookMatches(candidates: ReturnType<typeof candidateFromBinding>[], bookTitle: string) {
  const titledCandidates = candidates.flatMap((candidate) => {
    if (!candidate.wikipediaUrl) return [];
    try {
      const pageTitle = decodeURIComponent(new URL(candidate.wikipediaUrl).pathname.replace(/^\/wiki\//, "")).replace(/_/g, " ");
      return [{ candidate, pageTitle }];
    } catch {
      return [];
    }
  });
  if (titledCandidates.length < 2) return new Set<string>();

  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "revisions");
  url.searchParams.set("rvprop", "content");
  url.searchParams.set("rvslots", "main");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", titledCandidates.map(({ pageTitle }) => pageTitle).join("|"));
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");

  try {
    const response = await wikimediaFetch(url);
    if (!response.ok) return new Set<string>();
    const payload = await response.json() as { query?: { pages?: Array<{ title?: string; revisions?: Array<{ slots?: { main?: { content?: string } } }> }> } };
    const extracts = new Map((payload.query?.pages ?? []).map((page) => [
      normalizeName(page.title),
      normalizeName(page.revisions?.[0]?.slots?.main?.content),
    ]));
    const phrases = normalizedBookPhrases(bookTitle);
    return new Set(titledCandidates.flatMap(({ candidate, pageTitle }) => {
      const extract = extracts.get(normalizeName(pageTitle)) ?? "";
      return phrases.some((phrase) => extract.includes(phrase)) && candidate.wikidataId ? [candidate.wikidataId] : [];
    }));
  } catch {
    return new Set<string>();
  }
}

async function wikipediaPageSource(wikipediaUrl: string) {
  const pageTitle = decodeURIComponent(new URL(wikipediaUrl).pathname.replace(/^\/wiki\//, "")).replace(/_/g, " ");
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "revisions");
  url.searchParams.set("rvprop", "content");
  url.searchParams.set("rvslots", "main");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", pageTitle);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  const response = await wikimediaFetch(url);
  if (!response.ok) return undefined;
  const payload = await response.json() as { query?: { pages?: Array<{ revisions?: Array<{ slots?: { main?: { content?: string } } }> }> } };
  return payload.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
}

async function wikipediaCoordinates(place: string) {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "coordinates");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", place);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  const response = await wikimediaFetch(url);
  if (!response.ok) return undefined;
  const payload = await response.json() as { query?: { pages?: Array<{ title?: string; coordinates?: Array<{ lat?: number; lon?: number }> }> } };
  const page = payload.query?.pages?.[0];
  const coordinates = page?.coordinates?.[0];
  return page?.title && Number.isFinite(coordinates?.lat) && Number.isFinite(coordinates?.lon)
    ? { place: page.title, lat: coordinates!.lat!, lng: coordinates!.lon! }
    : undefined;
}

async function enrichCandidateLocation(candidate: ReturnType<typeof candidateFromBinding>) {
  if (candidate.status === "resolved") return candidate;
  try {
    if (candidate.place) {
      const coordinates = await wikipediaCoordinates(candidate.place);
      if (coordinates) return { ...candidate, ...coordinates, status: "resolved" as const, unresolvedReason: undefined };
    }
    if (!candidate.wikipediaUrl) return candidate;
    const source = await wikipediaPageSource(candidate.wikipediaUrl);
    const birthPlace = source?.match(/^\s*\|\s*birth_place\s*=\s*(.+)$/mi)?.[1];
    if (!birthPlace) return candidate;
    const linkedPlace = birthPlace.match(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/)?.[1]?.trim();
    const place = linkedPlace || plainWikipediaValue(birthPlace);
    if (!place) return candidate;
    const coordinates = await wikipediaCoordinates(place);
    return coordinates ? { ...candidate, ...coordinates, status: "resolved" as const, unresolvedReason: undefined } : candidate;
  } catch {
    return candidate;
  }
}

async function queryWikidata(query: string) {
  const url = new URL("https://query.wikidata.org/sparql");
  url.searchParams.set("query", query);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await wikimediaFetch(url);
    if (response.ok) {
      const payload = await response.json() as { results?: { bindings?: Binding[] } };
      return payload.results?.bindings ?? [];
    }
    if (response.status !== 429 || attempt === 2) throw new Error(`Wikidata query failed: ${response.status}`);
    const retryAfter = Math.min(Number(response.headers.get("Retry-After") ?? 1), 5);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
  }
  return [];
}

async function searchWikidataIds(author: string) {
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.searchParams.set("action", "wbsearchentities");
  url.searchParams.set("search", author);
  url.searchParams.set("language", "en");
  url.searchParams.set("uselang", "en");
  url.searchParams.set("type", "item");
  url.searchParams.set("limit", "8");
  url.searchParams.set("format", "json");
  try {
    const response = await wikimediaFetch(url);
    if (!response.ok) return [];
    const payload = await response.json() as { search?: Array<{ id?: string }> };
    return (payload.search ?? []).flatMap((result) => result.id && /^Q\d+$/.test(result.id) ? [result.id] : []);
  } catch {
    return [];
  }
}

function candidateFromBinding(author: string, binding: Binding) {
  const wikidataId = binding.author?.value.split("/").pop();
  const point = binding.coord?.value.match(/Point\((-?[\d.]+) (-?[\d.]+)\)/);
  const base = {
    author,
    title: binding.authorLabel?.value ?? author,
    description: binding.description?.value,
    wikidataId,
    sourceUrl: wikidataId ? `https://www.wikidata.org/wiki/${wikidataId}` : undefined,
    wikipediaUrl: binding.wikipedia?.value,
    isWriter: binding.isWriter?.value === "true",
    bookMatch: binding.bookMatch?.value === "true",
    sitelinks: Number(binding.sitelinks?.value ?? 0),
    place: binding.birthplaceLabel?.value,
    country: binding.countryLabel?.value,
  };
  const birthplaceLabel = binding.birthplaceLabel?.value;
  if (!birthplaceLabel || /^Q\d+$/.test(birthplaceLabel)) return { ...base, status: "unresolved" as const, unresolvedReason: "missing_birthplace" as const };
  if (!point) return { ...base, status: "unresolved" as const, unresolvedReason: "missing_coordinates" as const };
  return {
    ...base,
    status: "resolved" as const,
    lng: Number(point[1]),
    lat: Number(point[2]),
  };
}

export async function GET(request: NextRequest) {
  const author = request.nextUrl.searchParams.get("name")?.replace(/\s+/g, " ").trim();
  const selectedId = request.nextUrl.searchParams.get("wikidataId")?.trim();
  const bookTitle = request.nextUrl.searchParams.get("title")?.trim();
  if (!author) return NextResponse.json({ error: "Missing author name" }, { status: 400 });
  if (author.length > 120) return NextResponse.json({ error: "Author name is too long" }, { status: 400 });
  if (selectedId && !/^Q\d+$/.test(selectedId)) return NextResponse.json({ error: "Invalid Wikidata ID" }, { status: 400 });

  const cacheKey = `v${AUTHOR_LOOKUP_VERSION}|${author.toLocaleLowerCase("en")}|${bookTitle?.toLocaleLowerCase("en") ?? "no-title"}|${selectedId ?? "search"}`;
  const cached = await readLookupCache(cacheKey).catch(() => undefined);
  if (cached) return NextResponse.json(cached, { headers: { "Cache-Control": "private, max-age=300" } });

  const subjectClause = selectedId
    ? `VALUES ?author { wd:${selectedId} }`
    : `VALUES ?matchedName { ${nameVariants(author).flatMap((name) => [`"${sparqlString(name)}"@en`, `"${sparqlString(name)}"@mul`]).join(" ")} }
       ?author (rdfs:label|skos:altLabel) ?matchedName;
               wdt:P31 wd:Q5.`;

  const bookMatchClause = bookTitle
    ? `BIND(EXISTS {
         VALUES ?matchedBookTitle { ${titleVariants(bookTitle).flatMap((title) => [`"${sparqlString(title)}"@en`, `"${sparqlString(title)}"@mul`]).join(" ")} }
         ?work wdt:P50 ?author;
               (rdfs:label|skos:altLabel) ?matchedBookTitle.
       } AS ?bookMatch)`
    : "BIND(false AS ?bookMatch)";

  const queryForSubject = (subject: string) => `
    SELECT DISTINCT ?author ?authorLabel ?description ?birthplaceLabel ?coord ?countryLabel ?wikipedia ?isWriter ?bookMatch ?sitelinks WHERE {
      ${subject}
      BIND(EXISTS { ?author wdt:P106/wdt:P279* wd:Q49757. } AS ?isWriter)
      ${bookMatchClause}
      OPTIONAL { ?author wikibase:sitelinks ?sitelinks. }
      OPTIONAL { ?author schema:description ?description. FILTER(LANG(?description) = "en") }
      OPTIONAL {
        ?wikipedia schema:about ?author;
                   schema:isPartOf <https://en.wikipedia.org/>.
      }
      OPTIONAL {
        ?author wdt:P19 ?birthplace.
        OPTIONAL { ?birthplace wdt:P625 ?coord. }
        OPTIONAL { ?birthplace wdt:P17 ?country. }
      }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
    }
    LIMIT 12
  `;

  try {
    let bindings = await queryWikidata(queryForSubject(subjectClause));
    if (!bindings.length && !selectedId) {
      const searchedIds = await searchWikidataIds(author);
      if (searchedIds.length) bindings = await queryWikidata(queryForSubject(`VALUES ?author { ${searchedIds.map((id) => `wd:${id}`).join(" ")} }`));
    }
    const unique = [...new Map(bindings.map((binding) => [binding.author?.value, binding])).values()];
    let candidates = unique.map((binding) => candidateFromBinding(author, binding));
    if (bookTitle && !selectedId && candidates.filter((candidate) => candidate.wikipediaUrl).length > 1 && !candidates.some((candidate) => candidate.bookMatch)) {
      const wikipediaMatches = await wikipediaBookMatches(candidates, bookTitle);
      candidates = candidates.map((candidate) => ({
        ...candidate,
        bookMatch: candidate.bookMatch || Boolean(candidate.wikidataId && wikipediaMatches.has(candidate.wikidataId)),
      }));
    }
    const selection = selectCandidate(author, candidates);
    candidates = selection.candidates;
    const selectedCandidate = selectedId ? candidates[0] : selection.selectedCandidate;
    const payload = !candidates.length
      ? { author, status: "unresolved", unresolvedReason: "missing_identity" }
      : selectedCandidate
        ? await enrichCandidateLocation(selectedCandidate)
        : { author, status: "ambiguous", candidates };
    await saveLookupCache(cacheKey, payload, new Date(Date.now() + CACHE_TTL)).catch(() => undefined);
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch {
    return NextResponse.json({ author, status: "retryable_error" }, { status: 502 });
  }
}

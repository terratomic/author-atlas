export type ContributorRole = "primary" | "coauthor" | "translator" | "editor" | "illustrator" | "narrator" | "unknown";

const collectiveAuthorMembers: Record<string, string[]> = {
  "christina lauren": ["Christina Hobbs", "Lauren Billings"],
};

export type Book = {
  title: string;
  author: string;
  authorKey: string;
  id: string;
  isbn?: string;
  goodreadsBookId?: string;
  goodreadsAuthorId?: string;
  additionalAuthors?: Array<{ name: string; authorKey: string; role: ContributorRole }>;
};

export type LookupStatus = "pending" | "resolved" | "ambiguous" | "unresolved" | "failed" | "deferred";

export type AuthorCandidate = {
  title?: string;
  description?: string;
  wikidataId?: string;
  place?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  sourceUrl?: string;
  wikipediaUrl?: string;
};

export type BookRecord = {
  id: string;
  title: string;
  isbn?: string;
  externalIds: { goodreads?: string };
  authorIds: string[];
  authorNames?: string[];
  authorRoles?: ContributorRole[];
};

export function booksFromDataset(dataset: AuthorDataset): Book[] {
  return dataset.activeBookIds.flatMap((id) => {
    const record = dataset.books[id];
    if (!record || !record.authorIds.length) return [];
    const names = record.authorIds.map((authorId, index) => record.authorNames?.[index] ?? dataset.authors[authorId]?.name).filter(Boolean) as string[];
    if (!names.length) return [];
    const collectiveMembers = collectiveAuthorMembers[normalizeAuthorName(names[0])];
    const primaryName = collectiveMembers?.[0] ?? names[0];
    const primaryAuthorId = collectiveMembers ? legacyAuthorId(normalizeAuthorName(primaryName)) : record.authorIds[0];
    return [{
      id: record.id,
      title: record.title,
      isbn: record.isbn,
      goodreadsBookId: record.externalIds.goodreads,
      author: primaryName,
      authorKey: primaryAuthorId,
      goodreadsAuthorId: collectiveMembers ? undefined : dataset.authors[record.authorIds[0]]?.externalIds.goodreads,
      additionalAuthors: [
        ...(collectiveMembers?.slice(1).map((name) => ({ name, authorKey: legacyAuthorId(normalizeAuthorName(name)), role: "coauthor" as const })) ?? []),
        ...record.authorIds.slice(1).map((authorId, index) => ({
        name: names[index + 1],
        authorKey: authorId,
        role: record.authorRoles?.[index + 1] ?? "unknown",
        })),
      ],
    }];
  });
}

export type AuthorRecord = {
  id: string;
  schemaVersion: 1;
  name: string;
  normalizedName: string;
  externalIds: {
    goodreads?: string;
    wikidata?: string;
  };
  fieldProvenance: {
    identity: FieldProvenance;
    birthplace?: FieldProvenance;
  };
  birthplace?: {
    name: string;
    country?: string;
    latitude: number;
    longitude: number;
  };
  lookupStatus: LookupStatus;
  identityStatus?: "identified" | "ambiguous" | "unresolved";
  locationStatus?: "resolved" | "missing_birthplace" | "missing_coordinates" | "failed";
  lookupVersion?: number;
  aliases?: string[];
  candidates?: AuthorCandidate[];
  confidence?: number;
  lookupError?: string;
  reviewedAt?: string;
  reviewedBy?: "automatic" | "manual";
  sourceUrl?: string;
  wikipediaUrl?: string;
  source: "wikidata" | "manual";
  updatedAt: string;
};

export type FieldProvenance = {
  origin: "wikidata" | "user";
  status: "verified" | "contributed";
  updatedAt: string;
};

export type AuthorDataset = {
  schemaVersion: 2;
  authors: Record<string, AuthorRecord>;
  books: Record<string, BookRecord>;
  activeBookIds: string[];
  activeFilename?: string;
};

export const DATASET_KEY = "author-atlas:authors:v2";
export const DATASET_BACKUPS_KEY = "author-atlas:backups:v1";
export const emptyDataset = (): AuthorDataset => ({ schemaVersion: 2, authors: {}, books: {}, activeBookIds: [] });

export function loadDataset(value: string | null): AuthorDataset {
  if (!value) return emptyDataset();
  const parsed = JSON.parse(value) as Partial<AuthorDataset> & { schemaVersion?: number };
  if (!parsed || typeof parsed !== "object" || !parsed.authors || typeof parsed.authors !== "object" || !parsed.books || typeof parsed.books !== "object") {
    throw new Error("Invalid dataset");
  }
  const idMap = new Map<string, string>();
  for (const key of Object.keys(parsed.authors ?? {})) {
    idMap.set(key, key.startsWith("author:") ? key : legacyAuthorId(key));
  }
  const authors = Object.fromEntries(Object.entries(parsed.authors ?? {}).map(([key, record]) => {
    const id = idMap.get(key) ?? key;
    const updatedAt = record.updatedAt ?? new Date(0).toISOString();
    const goodreadsId = record.externalIds?.goodreads ?? key.match(/^goodreads:(.+)$/)?.[1];
    return [id, {
    ...record,
    id,
    externalIds: { ...record.externalIds, goodreads: goodreadsId },
    lookupStatus: record.lookupStatus === "resolved" ? "resolved" : record.lookupStatus ?? "unresolved",
    identityStatus: record.identityStatus ?? (record.externalIds?.wikidata ? "identified" : record.lookupStatus === "ambiguous" ? "ambiguous" : "unresolved"),
    locationStatus: record.locationStatus ?? (record.birthplace ? "resolved" : record.lookupStatus === "failed" ? "failed" : undefined),
    aliases: record.aliases ?? [record.name],
    fieldProvenance: record.fieldProvenance ?? {
      identity: { origin: record.source === "manual" ? "user" : "wikidata", status: record.source === "manual" ? "contributed" : "verified", updatedAt },
      ...(record.birthplace ? { birthplace: { origin: record.source === "manual" ? "user" : "wikidata", status: record.source === "manual" ? "contributed" : "verified", updatedAt } } : {}),
    },
  }];
  })) as Record<string, AuthorRecord>;
  const books = Object.fromEntries(Object.entries(parsed.books ?? {}).map(([key, book]) => [key, {
    ...book,
    authorIds: book.authorIds.map((id) => idMap.get(id) ?? id),
  }]));
  return {
    schemaVersion: 2,
    authors,
    books,
    activeBookIds: Array.isArray(parsed.activeBookIds) ? parsed.activeBookIds : [],
    activeFilename: typeof parsed.activeFilename === "string" ? parsed.activeFilename : undefined,
  };
}

export function normalizeAuthorName(name: string) {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function authorKey() {
  return createAuthorId();
}

export function createAuthorId() {
  return `author:${crypto.randomUUID()}`;
}

function legacyAuthorId(normalizedName: string) {
  let hash = 2166136261;
  for (const character of normalizedName) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `author:legacy-${(hash >>> 0).toString(36)}`;
}

function contributorNameAndRole(value: string): { name: string; role: ContributorRole } {
  const match = value.match(/^(.*?)\s*\((translator|editor|illustrator|narrator|co-?author|author)\)\s*$/i);
  if (!match) return { name: value.replace(/\s+/g, " ").trim(), role: "unknown" };
  const rawRole = match[2].toLowerCase();
  const role: ContributorRole = rawRole === "author" || rawRole.startsWith("co-") || rawRole === "coauthor"
    ? "coauthor"
    : rawRole as ContributorRole;
  return { name: match[1].replace(/\s+/g, " ").trim(), role };
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  const headers = rows[0] ?? [];
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header.trim(), values[index]?.trim() ?? ""])),
  );
}

function isRead(row: Record<string, string>) {
  const exclusiveShelf = row["Exclusive Shelf"]?.toLowerCase();
  if (exclusiveShelf) return exclusiveShelf === "read";

  const legacyShelf = row.Shelves?.toLowerCase();
  if (legacyShelf) return !legacyShelf.split(/[;, ]+/).some((shelf) => shelf === "to-read" || shelf === "currently-reading");
  return true;
}

export function booksFromGoodreads(text: string): Book[] {
  const localAuthorIds = new Map<string, string>();
  const localAuthorId = (name: string, goodreadsAuthorId?: string) => {
    const identity = goodreadsAuthorId ? `goodreads:${goodreadsAuthorId}` : `name:${normalizeAuthorName(name)}`;
    const existing = localAuthorIds.get(identity);
    if (existing) return existing;
    const id = createAuthorId();
    localAuthorIds.set(identity, id);
    return id;
  };
  return parseCsv(text)
    .filter(isRead)
    .map((row) => {
      const creditedName = row.Author.replace(/\s+/g, " ").trim();
      const collectiveMembers = collectiveAuthorMembers[normalizeAuthorName(creditedName)];
      const name = collectiveMembers?.[0] ?? creditedName;
      const isbn = (row.ISBN || row.ISBN13 || "").replace(/^="|"$/g, "") || undefined;
      const goodreadsBookId = row["Book Id"] || row["Book ID"] || undefined;
      const goodreadsAuthorId = row["Author ID"] || row["Goodreads Author ID"] || undefined;
      const key = localAuthorId(name, collectiveMembers ? undefined : goodreadsAuthorId);
      const additionalAuthors = (row["Additional Authors"] || "")
        .split(/\s*,\s*/)
        .map(contributorNameAndRole)
        .filter((contributor) => Boolean(contributor.name))
        .map((contributor) => ({ ...contributor, authorKey: localAuthorId(contributor.name) }));
      if (collectiveMembers) {
        additionalAuthors.unshift(...collectiveMembers.slice(1).map((member) => ({
          name: member,
          authorKey: localAuthorId(member),
          role: "coauthor" as const,
        })));
      }
      return {
        title: row.Title,
        author: name,
        authorKey: key,
        id: goodreadsBookId ? `goodreads:${goodreadsBookId}` : isbn ? `isbn:${isbn}` : `title:${row.Title.toLowerCase()}|${key}`,
        isbn,
        goodreadsBookId,
        goodreadsAuthorId: collectiveMembers ? undefined : goodreadsAuthorId,
        additionalAuthors,
      };
    })
    .filter((book) => book.title && book.author);
}

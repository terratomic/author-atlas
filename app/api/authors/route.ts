import { NextRequest, NextResponse } from "next/server";
import type { AuthorRecord } from "../../author-data";
import { readSharedAuthors, saveSharedAuthors } from "../../author-store";

const writeWindows = new Map<string, { startedAt: number; count: number }>();

function validAuthorRecord(value: unknown): value is AuthorRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AuthorRecord>;
  const birthplace = record.birthplace;
  const identityProvenance = record.fieldProvenance?.identity;
  return typeof record.id === "string" && record.id.length <= 180
    && typeof record.name === "string" && record.name.length > 0 && record.name.length <= 160
    && typeof record.normalizedName === "string" && record.normalizedName.length <= 180
    && record.schemaVersion === 1
    && Boolean(record.externalIds && typeof record.externalIds === "object")
    && Boolean(identityProvenance
      && ["wikidata", "user"].includes(identityProvenance.origin)
      && ["verified", "contributed"].includes(identityProvenance.status)
      && Number.isFinite(Date.parse(identityProvenance.updatedAt)))
    && ["pending", "resolved", "ambiguous", "unresolved", "failed", "deferred"].includes(record.lookupStatus ?? "")
    && ["wikidata", "manual"].includes(record.source ?? "")
    && typeof record.updatedAt === "string" && Number.isFinite(Date.parse(record.updatedAt))
    && (!birthplace || (typeof birthplace.name === "string" && birthplace.name.length <= 180
      && Number.isFinite(birthplace.latitude) && Math.abs(birthplace.latitude) <= 90
      && Number.isFinite(birthplace.longitude) && Math.abs(birthplace.longitude) <= 180));
}

function allowsWrite(request: NextRequest) {
  const key = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const existing = writeWindows.get(key);
  if (!existing || now - existing.startedAt >= 60_000) {
    writeWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  existing.count += 1;
  return existing.count <= 30;
}

export async function GET() {
  return NextResponse.json({ authors: await readSharedAuthors() });
}

export async function POST(request: NextRequest) {
  if (!allowsWrite(request)) return NextResponse.json({ error: "Too many shared-data updates" }, { status: 429 });
  if (Number(request.headers.get("content-length") ?? 0) > 500_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  const body = await request.json() as { authors?: AuthorRecord[] };
  if (!Array.isArray(body.authors) || body.authors.length > 100 || !body.authors.every(validAuthorRecord)) {
    return NextResponse.json({ error: "Invalid author records" }, { status: 400 });
  }
  await saveSharedAuthors(body.authors);
  return NextResponse.json({ saved: body.authors.length });
}

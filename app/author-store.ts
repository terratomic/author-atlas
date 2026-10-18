import type { AuthorRecord } from "./author-data";

type AuthorRow = { id: string; record_json: string };

async function authorDatabase() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("Shared author database is unavailable");
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS authors (
      id TEXT PRIMARY KEY NOT NULL,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS author_history (
      history_id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      replaced_at TEXT NOT NULL
    )
  `).run();
  return env.DB;
}

export async function readSharedAuthors(): Promise<Record<string, AuthorRecord>> {
  const database = await authorDatabase();
  const result = await database.prepare("SELECT id, record_json FROM authors").all<AuthorRow>();
  return Object.fromEntries(result.results.map((row) => [row.id, JSON.parse(row.record_json) as AuthorRecord]));
}

export async function saveSharedAuthors(records: AuthorRecord[]) {
  const identified = records.filter((record) => record.birthplace || record.identityStatus === "identified" || record.externalIds.wikidata);
  if (!identified.length) return;
  const database = await authorDatabase();
  await database.batch(identified.flatMap((record) => {
    const json = JSON.stringify(record);
    return [
      database.prepare(`
        INSERT INTO author_history (author_id, record_json, replaced_at)
        SELECT id, record_json, ? FROM authors WHERE id = ? AND record_json != ? AND updated_at < ?
      `).bind(new Date().toISOString(), record.id, json, record.updatedAt),
      database.prepare(`
        INSERT INTO authors (id, record_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at
        WHERE excluded.updated_at > authors.updated_at
      `).bind(record.id, json, record.updatedAt),
    ];
  }));
}

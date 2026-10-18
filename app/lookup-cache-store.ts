type LookupCacheRow = { payload_json: string; expires_at: string };

async function lookupDatabase() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("Lookup cache database is unavailable");
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS author_lookup_cache (
      cache_key TEXT PRIMARY KEY NOT NULL,
      payload_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  return env.DB;
}

export async function readLookupCache(cacheKey: string) {
  const database = await lookupDatabase();
  const row = await database.prepare(
    "SELECT payload_json, expires_at FROM author_lookup_cache WHERE cache_key = ?",
  ).bind(cacheKey).first<LookupCacheRow>();
  if (!row) return undefined;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await database.prepare("DELETE FROM author_lookup_cache WHERE cache_key = ?").bind(cacheKey).run();
    return undefined;
  }
  return JSON.parse(row.payload_json) as unknown;
}

export async function saveLookupCache(cacheKey: string, payload: unknown, expiresAt: Date) {
  const database = await lookupDatabase();
  await database.prepare(`
    INSERT INTO author_lookup_cache (cache_key, payload_json, expires_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).bind(cacheKey, JSON.stringify(payload), expiresAt.toISOString(), new Date().toISOString()).run();
}

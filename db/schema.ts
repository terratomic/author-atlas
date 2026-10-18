import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const authors = sqliteTable("authors", {
  id: text("id").primaryKey(),
  recordJson: text("record_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const authorHistory = sqliteTable("author_history", {
  historyId: integer("history_id").primaryKey({ autoIncrement: true }),
  authorId: text("author_id").notNull(),
  recordJson: text("record_json").notNull(),
  replacedAt: text("replaced_at").notNull(),
});

export const authorLookupCache = sqliteTable("author_lookup_cache", {
  cacheKey: text("cache_key").primaryKey(),
  payloadJson: text("payload_json").notNull(),
  expiresAt: text("expires_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

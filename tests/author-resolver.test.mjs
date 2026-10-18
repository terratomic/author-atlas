import assert from "node:assert/strict";
import test from "node:test";
import { plainWikipediaValue, selectCandidate } from "../app/author-resolver.ts";

const candidate = (title, description, options = {}) => ({
  author: title,
  title,
  description,
  wikidataId: options.wikidataId ?? `Q${Math.floor(Math.random() * 100000)}`,
  wikipediaUrl: options.wikipediaUrl,
  isWriter: options.isWriter ?? false,
  bookMatch: options.bookMatch ?? false,
  sitelinks: options.sitelinks ?? 0,
  status: "unresolved",
  unresolvedReason: "missing_birthplace",
});

test("prefers the exact English Wikipedia writer for Barack Obama", () => {
  const president = candidate("Barack Obama", "American politician and author", { wikipediaUrl: "https://en.wikipedia.org/wiki/Barack_Obama", sitelinks: 250 });
  const senior = candidate("Barack Obama Sr.", "Kenyan economist", { wikipediaUrl: "https://en.wikipedia.org/wiki/Barack_Obama_Sr.", sitelinks: 45 });
  assert.equal(selectCandidate("Barack Obama", [senior, president]).selectedCandidate, president);
});

test("prefers Euripides over a similarly named non-English record", () => {
  const euripides = candidate("Euripides", "Classical Athenian playwright", { wikipediaUrl: "https://en.wikipedia.org/wiki/Euripides", isWriter: true });
  const other = candidate("Euripides of Athens", "tragedy writer");
  assert.equal(selectCandidate("Euripides", [other, euripides]).selectedCandidate, euripides);
});

test("accepts a single exact writer record for Yáng Shuāng-zǐ", () => {
  const author = candidate("Yáng Shuāng-zǐ", "Taiwanese writer", { wikipediaUrl: "https://en.wikipedia.org/wiki/Yang_Shuang-zi" });
  assert.equal(selectCandidate("Yáng Shuāng-zǐ", [author]).selectedCandidate, author);
});

test("extracts plain and linked Wikipedia birthplace values", () => {
  assert.equal(plainWikipediaValue("[[Wuri District|Wuri]], [[Taichung]]<ref>source</ref>"), "Wuri District, Taichung");
  assert.equal(plainWikipediaValue("Atlanta, Georgia, United States"), "Atlanta, Georgia, United States");
});

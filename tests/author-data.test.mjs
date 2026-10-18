import assert from "node:assert/strict";
import test from "node:test";
import { authorKey, booksFromDataset, booksFromGoodreads, loadDataset, normalizeAuthorName, parseCsv } from "../app/author-data.ts";

test("parses quoted commas and multiline CSV fields", () => {
  const rows = parseCsv('Title,Author,My Review\n"A, Book","Doe, Jane","Line one\nLine two"\n');
  assert.equal(rows[0].Title, "A, Book");
  assert.equal(rows[0].Author, "Doe, Jane");
  assert.equal(rows[0]["My Review"], "Line one\nLine two");
});

test("imports only read books and records additional authors", () => {
  const csv = [
    "Book Id,Title,Author,Additional Authors,Exclusive Shelf",
    '1,"Read Book","Primary Author","Second Author, Third Author",read',
    '2,"Later Book","Other Author","",to-read',
  ].join("\n");
  const books = booksFromGoodreads(csv);
  assert.equal(books.length, 1);
  assert.deepEqual(books[0].additionalAuthors?.map((author) => author.name), ["Second Author", "Third Author"]);
  assert.deepEqual(books[0].additionalAuthors?.map((author) => author.role), ["unknown", "unknown"]);
});

test("classifies explicit contributor roles and expands collective pen names", () => {
  const csv = [
    "Book Id,Title,Author,Additional Authors,Exclusive Shelf",
    '1,"A Book","Primary Author","Person One (Translator), Person Two (Author)",read',
    '2,"A Romance","Christina Lauren","",read',
  ].join("\n");
  const books = booksFromGoodreads(csv);
  assert.deepEqual(books[0].additionalAuthors?.map(({ name, role }) => [name, role]), [
    ["Person One", "translator"],
    ["Person Two", "coauthor"],
  ]);
  assert.equal(books[1].author, "Christina Hobbs");
  assert.equal(books[1].additionalAuthors?.[0].name, "Lauren Billings");
  assert.match(books[1].additionalAuthors?.[0].authorKey ?? "", /^author:/);
  assert.equal(books[1].additionalAuthors?.[0].role, "coauthor");
});

test("normalizes names and keeps primary IDs app-owned", () => {
  assert.equal(normalizeAuthorName("Gabriel García Márquez"), "gabriel garcia marquez");
  assert.match(authorKey(), /^author:/);
});

test("migrates legacy datasets and restores the active library", () => {
  const legacy = {
    schemaVersion: 1,
    authors: {
      "name:test author": {
        id: "name:test author",
        schemaVersion: 1,
        name: "Test Author",
        normalizedName: "test author",
        externalIds: {},
        lookupStatus: "resolved",
        source: "wikidata",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    books: {
      "goodreads:1": {
        id: "goodreads:1",
        title: "Test Book",
        externalIds: { goodreads: "1" },
        authorIds: ["name:test author"],
        authorNames: ["Test Author"],
      },
    },
    activeBookIds: ["goodreads:1"],
  };
  const dataset = loadDataset(JSON.stringify(legacy));
  assert.equal(dataset.schemaVersion, 2);
  const migratedAuthor = Object.values(dataset.authors)[0];
  assert.match(migratedAuthor.id, /^author:legacy-/);
  assert.deepEqual(migratedAuthor.aliases, ["Test Author"]);
  assert.equal(migratedAuthor.fieldProvenance.identity.status, "verified");
  assert.equal(dataset.books["goodreads:1"].authorIds[0], migratedAuthor.id);
  assert.equal(booksFromDataset(dataset)[0].title, "Test Book");
});

test("uses app-owned IDs while grouping the same imported name", () => {
  const csv = [
    "Book Id,Title,Author,Exclusive Shelf",
    '1,"First","Same Name",read',
    '2,"Second","Same Name",read',
  ].join("\n");
  const books = booksFromGoodreads(csv);
  assert.match(books[0].authorKey, /^author:/);
  assert.equal(books[0].authorKey, books[1].authorKey);
});

test("stores Goodreads author IDs as external IDs instead of primary IDs", () => {
  const books = booksFromGoodreads([
    "Book Id,Title,Author,Author ID,Exclusive Shelf",
    '1,"First","Same Name",42,read',
    '2,"Second","Same Name",42,read',
  ].join("\n"));
  assert.match(books[0].authorKey, /^author:/);
  assert.equal(books[0].authorKey, books[1].authorKey);
  assert.equal(books[0].goodreadsAuthorId, "42");
});

test("rejects malformed saved datasets", () => {
  assert.throws(() => loadDataset('{"authors":null,"books":{}}'), /Invalid dataset/);
});

export type ResolverCandidate = {
  title?: string;
  description?: string;
  wikipediaUrl?: string;
  isWriter?: boolean;
  bookMatch?: boolean;
  sitelinks?: number;
};

export function normalizeResolverText(value?: string) {
  return value?.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, " ").trim() ?? "";
}

function isWriterDescription(description?: string) {
  return Boolean(description && /\b(author|writer|novelist|poet|playwright|essayist|journalist|screenwriter|memoirist|biographer|illustrator|cartoonist)\b/i.test(description));
}

function candidateLooksLikeWriter(candidate: ResolverCandidate) {
  return Boolean(candidate.isWriter || isWriterDescription(candidate.description));
}

function candidateScore(author: string, candidate: ResolverCandidate) {
  let score = 0;
  if (candidate.bookMatch) score += 24;
  if (normalizeResolverText(candidate.title) === normalizeResolverText(author)) score += 10;
  if (candidateLooksLikeWriter(candidate)) score += 6;
  if (candidate.wikipediaUrl) score += 4;
  score += Math.min(3, Math.floor(Math.log10(Math.max(1, candidate.sitelinks ?? 0))));
  return score;
}

export function selectCandidate<T extends ResolverCandidate>(author: string, input: T[]) {
  const candidates = [...input].sort((left, right) => candidateScore(author, right) - candidateScore(author, left));
  const topScore = candidates[0] ? candidateScore(author, candidates[0]) : 0;
  const nextScore = candidates[1] ? candidateScore(author, candidates[1]) : -1;
  const exactWritersWithEnglishWikipedia = candidates.filter((candidate) =>
    normalizeResolverText(candidate.title) === normalizeResolverText(author) && candidateLooksLikeWriter(candidate) && candidate.wikipediaUrl,
  );
  const exactWriterCandidates = candidates.filter((candidate) =>
    normalizeResolverText(candidate.title) === normalizeResolverText(author) && candidateLooksLikeWriter(candidate),
  );
  const bookMatches = candidates.filter((candidate) => candidate.bookMatch);
  const decisiveCandidate = bookMatches.length === 1
    ? bookMatches[0]
    : exactWritersWithEnglishWikipedia.length === 1
      ? exactWritersWithEnglishWikipedia[0]
      : exactWriterCandidates.length === 1
        ? exactWriterCandidates[0]
        : topScore - nextScore >= 6
          ? candidates[0]
          : undefined;
  const singleCandidateIsCredible = candidates.length === 1 && (
    candidates[0].bookMatch || candidateLooksLikeWriter(candidates[0]) || normalizeResolverText(candidates[0].title) === normalizeResolverText(author)
  );
  return { candidates, selectedCandidate: singleCandidateIsCredible ? candidates[0] : decisiveCandidate };
}

export function plainWikipediaValue(value: string) {
  return value
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>|<ref\b[^>]*\/>/gi, "")
    .replace(/\{\{(?:nowrap|small|plainlist)\|([^{}]+)\}\}/gi, "$1")
    .replace(/\{\{[^{}]+\}\}/g, "")
    .replace(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, "$1")
    .replace(/<br\s*\/?\s*>/gi, ", ")
    .replace(/'''?|<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

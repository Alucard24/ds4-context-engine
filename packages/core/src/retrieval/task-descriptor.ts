const STOPWORDS = new Set([
  "about", "after", "again", "anche", "ancora", "avere", "before", "come", "could", "della",
  "delle", "degli", "detto", "does", "doing", "done", "dove", "essere", "fare", "from", "have",
  "into", "just", "make", "molto", "nella", "nello", "perche", "pero", "poco", "quale", "quella",
  "quello", "questo", "questa", "should", "stato", "stata", "stati", "state", "than", "that", "their",
  "them", "then", "there", "these", "this", "those", "tutta", "tutto", "voglio", "want", "were", "what",
  "when", "where", "which", "with", "would", "your",
]);

const TECHNOLOGIES = [
  "typescript", "javascript", "node", "sqlite", "sql", "react", "python", "dotnet", "csharp", "java",
  "rust", "golang", "docker", "kubernetes", "azure", "aws", "postgres", "mysql", "redis", "git", "pi",
] as const;

export interface TaskDescriptor {
  objective: string;
  entities: string[];
  symbols: string[];
  files: string[];
  errors: string[];
  technologies: string[];
  keywords: string[];
  phrases: string[];
  exactIdentifiers: string[];
  queryTerms: string[];
}

function unique(values: Iterable<string>, limit = 24): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLocaleLowerCase("en-US");
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].flatMap((match) => match[1] ? [match[1]] : []);
}

export function messageText(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!block || typeof block !== "object" || !("type" in block) || !("text" in block)) return [];
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

export function currentRequestText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user") continue;
    return messageText(message).trim();
  }
  return "";
}

export function describeTask(text: string): TaskDescriptor {
  const bounded = text.trim().slice(0, 20_000);
  const backticked = matches(bounded, /`([^`\n]{2,160})`/gu);
  const quoted = unique([
    ...matches(bounded, /"([^"\n]{4,200})"/gu),
    ...matches(bounded, /'([^'\n]{4,200})'/gu),
  ], 8);
  const files = unique(matches(
    bounded,
    /((?:[A-Za-z]:)?(?:\.{0,2}[\\/])?(?:[\w.@+-]+[\\/])*[\w.@+-]+\.[A-Za-z0-9]{1,12})/gu,
  ), 16);
  const qualified = matches(
    bounded,
    /\b([A-Za-z_$][\w$]*(?:(?:::|\.)[A-Za-z_$][\w$]*)+)\b/gu,
  );
  const flags = matches(bounded, /(?:^|\s)(--[a-z0-9][a-z0-9-]*)\b/giu)
    .map((value) => value.trim())
    .filter((value) => value.startsWith("--"));
  const wordCandidates = matches(bounded, /\b([A-Za-z_$][A-Za-z0-9_$-]{2,})\b/gu);
  const symbols = unique([
    ...backticked.filter((value) => !/\s/u.test(value)),
    ...qualified,
    ...flags,
    ...wordCandidates.filter((value) =>
      /[_$-]/u.test(value)
      || /[a-z][A-Z]/u.test(value)
      || /^[A-Z][A-Za-z0-9]+$/u.test(value)
      || /^--[a-z0-9-]+$/iu.test(value)
    ),
  ], 20);
  const errors = unique(wordCandidates.filter((value) =>
    /^(?:ERR(?:OR)?|SQLITE|HTTP|CS|TS|E)[-_]?[A-Z0-9_]{2,}$/u.test(value)
    || /^(?:ENOENT|EACCES|ECONNRESET|ETIMEDOUT|SIG[A-Z]+)$/u.test(value)
  ), 12);
  const lower = bounded.toLocaleLowerCase("en-US");
  const technologies = TECHNOLOGIES.filter((technology) =>
    new RegExp(`(^|[^a-z0-9])${technology}([^a-z0-9]|$)`, "u").test(lower)
  );
  const keywords = unique(
    matches(lower, /([\p{L}\p{N}_-]{4,})/gu)
      .filter((word) => !STOPWORDS.has(word) && !/^\d+$/u.test(word)),
    20,
  );
  const exactIdentifiers = unique([...backticked, ...files, ...symbols, ...errors], 24);
  const entities = unique([...exactIdentifiers, ...technologies], 24);
  const queryTerms = unique([
    ...exactIdentifiers,
    ...quoted,
    ...keywords,
  ], 24);

  return {
    objective: bounded.slice(0, 500),
    entities,
    symbols,
    files,
    errors,
    technologies: [...technologies],
    keywords,
    phrases: quoted,
    exactIdentifiers,
    queryTerms,
  };
}

export function buildFtsQuery(terms: readonly string[]): string {
  return unique(terms, 16)
    .map((term) => `"${term.replace(/"/gu, '""')}"`)
    .join(" OR ");
}

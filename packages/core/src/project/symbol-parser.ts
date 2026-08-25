import { sha256 } from "../shared/hash.ts";

export const REGEX_SYMBOL_PARSER_VERSION = "regex-structural-v1";

export type StructuralSymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "namespace"
  | "type"
  | "function"
  | "method"
  | "variable"
  | "struct";

export interface SymbolParserInput {
  projectPath: string;
  filePath: string;
  fileHash: string;
  language?: string;
  content: string;
}

export interface ParsedSymbol {
  name: string;
  qualifiedName: string;
  kind: StructuralSymbolKind;
  signature: string;
  parentSymbol?: string;
  startLine: number;
  endLine: number;
  imports: string[];
  references: string[];
}

export interface ParsedSymbolDocument {
  parserId: string;
  language: string;
  imports: string[];
  symbols: ParsedSymbol[];
}

export interface SymbolParser {
  readonly id: string;
  readonly languages: readonly string[];
  parse(input: SymbolParserInput): ParsedSymbolDocument | undefined;
}

interface MutableSymbol {
  name: string;
  kind: StructuralSymbolKind;
  signature: string;
  startLine: number;
  endLine: number;
  parentSymbol?: string;
}

const SUPPORTED_LANGUAGES = ["typescript", "javascript", "python", "go"] as const;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const REFERENCE_STOP_WORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "def", "defer", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "fn", "for", "from", "func", "function", "go", "if", "implements",
  "import", "in", "interface", "let", "map", "namespace", "new", "nil", "none",
  "package", "pass", "private", "protected", "public", "range", "return", "select",
  "static", "struct", "switch", "this", "throw", "true", "try", "type", "undefined",
  "var", "while", "with", "yield",
]);
const CONTROL_METHOD_NAMES = new Set(["catch", "for", "if", "switch", "while", "with"]);

function unique(values: Iterable<string>, limit: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function uniqueCaseSensitive(values: Iterable<string>, limit: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function lexicalLines(content: string, language: string): string[] | undefined {
  const lines = content.split(/\r?\n/u);
  const output: string[] = [];
  let quote: "'" | '"' | "`" | undefined;
  let triple: "'''" | '\"\"\"' | undefined;
  let blockComment = false;
  let escaped = false;
  const stack: string[] = [];
  const closing: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

  for (const line of lines) {
    let clean = "";
    for (let index = 0; index < line.length; index++) {
      const char = line[index] ?? "";
      const next = line[index + 1] ?? "";
      const three = line.slice(index, index + 3);
      if (triple) {
        if (three === triple) {
          index += 2;
          triple = undefined;
        }
        clean += " ";
        continue;
      }
      if (blockComment) {
        if (char === "*" && next === "/") {
          index++;
          blockComment = false;
        }
        clean += " ";
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = undefined;
        clean += " ";
        continue;
      }
      if (language === "python" && (three === "'''" || three === '\"\"\"')) {
        triple = three as "'''" | '\"\"\"';
        index += 2;
        clean += " ";
        continue;
      }
      if (char === "/" && next === "*") {
        index++;
        blockComment = true;
        clean += " ";
        continue;
      }
      if ((char === "/" && next === "/") || (language === "python" && char === "#")) break;
      if (char === "'" || char === '"' || (char === "`" && language !== "python")) {
        quote = char;
        clean += " ";
        continue;
      }
      clean += char;
      if (char === "(" || char === "[" || char === "{") stack.push(char);
      else if (char in closing) {
        if (stack.pop() !== closing[char]) return undefined;
      }
    }
    output.push(clean);
    if (quote && quote !== "`") quote = undefined;
  }
  if (blockComment || triple || quote || stack.length > 0) return undefined;
  return output;
}

function braceEnd(lines: readonly string[], startIndex: number): number {
  let depth = 0;
  let opened = false;
  for (let index = startIndex; index < lines.length; index++) {
    for (const char of lines[index] ?? "") {
      if (char === "{") {
        depth++;
        opened = true;
      } else if (char === "}" && opened) {
        depth--;
        if (depth === 0) return index + 1;
      }
    }
    if (!opened && /;\s*$/u.test(lines[index] ?? "")) return index + 1;
  }
  return startIndex + 1;
}

function signatureAt(lines: readonly string[], startIndex: number, language: string): string {
  const parts: string[] = [];
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 12); index++) {
    const part = (lines[index] ?? "").trim();
    if (part) parts.push(part);
    const joined = parts.join(" ");
    if (language === "python" ? /:\s*$/u.test(joined) : /(?:\{|;|=>)\s*$/u.test(joined)) break;
  }
  return parts.join(" ").replace(/\s+/gu, " ").slice(0, 500);
}

function pythonEnd(lines: readonly string[], startIndex: number): number {
  const declaration = lines[startIndex] ?? "";
  const indent = declaration.match(/^\s*/u)?.[0].length ?? 0;
  let end = startIndex + 1;
  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    const nextIndent = line.match(/^\s*/u)?.[0].length ?? 0;
    if (nextIndent <= indent) break;
    end = index + 1;
  }
  return end;
}

function importsFor(lines: readonly string[], language: string): string[] {
  const imports: string[] = [];
  let goImportBlock = false;
  for (const line of lines) {
    let match: RegExpMatchArray | null = null;
    if (language === "typescript" || language === "javascript") {
      match = line.match(/^\s*import(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/u)
        ?? line.match(/\brequire\(\s*["']([^"']+)["']\s*\)/u);
    } else if (language === "python") {
      match = line.match(/^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/u);
      if (match?.[2] && !match[1]) match[1] = match[2];
    } else if (language === "go") {
      if (/^\s*import\s*\(\s*$/u.test(line)) {
        goImportBlock = true;
        continue;
      }
      if (goImportBlock && /^\s*\)\s*$/u.test(line)) {
        goImportBlock = false;
        continue;
      }
      match = goImportBlock
        ? line.match(/^\s*(?:[A-Za-z_.]+\s+)?"([^"]+)"/u)
        : line.match(/^\s*import\s+(?:[A-Za-z_.]+\s+)?"([^"]+)"/u);
    }
    if (match?.[1]) imports.push(match[1]);
  }
  return unique(imports, 64);
}

function referencesFor(lines: readonly string[], symbol: MutableSymbol, imports: readonly string[]): string[] {
  const text = lines.slice(symbol.startLine - 1, symbol.endLine).join("\n");
  const values: string[] = [];
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/gu)) {
    const value = match[1];
    if (!value || value === symbol.name || REFERENCE_STOP_WORDS.has(value.toLowerCase())) continue;
    if (IDENTIFIER.test(value)) values.push(value);
  }
  return uniqueCaseSensitive([...imports, ...values], 64);
}

function assignParents(symbols: MutableSymbol[]): void {
  const ordered = [...symbols].sort((left, right) => left.startLine - right.startLine || right.endLine - left.endLine);
  for (const symbol of ordered) {
    if (symbol.parentSymbol) continue;
    const parents = ordered.filter((candidate) =>
      candidate !== symbol
      && candidate.startLine <= symbol.startLine
      && candidate.endLine >= symbol.endLine
      && (candidate.startLine < symbol.startLine || candidate.endLine > symbol.endLine)
    );
    parents.sort((left, right) =>
      (left.endLine - left.startLine) - (right.endLine - right.startLine)
      || right.startLine - left.startLine
    );
    if (parents[0]) symbol.parentSymbol = parents[0].name;
  }
}

function parseTypeScript(lines: readonly string[], clean: readonly string[], language: string): MutableSymbol[] {
  const symbols: MutableSymbol[] = [];
  const declaration = /^\s*(?:(?:export|declare|default|abstract)\s+)*(class|interface|enum|namespace|type)\s+([A-Za-z_$][\w$]*)/u;
  const fn = /^\s*(?:(?:export|declare|default)\s+)*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/u;
  const variable = /^\s*(?:(?:export|declare|default)\s+)*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/u;
  for (let index = 0; index < clean.length; index++) {
    const line = clean[index] ?? "";
    const declared = line.match(declaration);
    const functionMatch = line.match(fn);
    const variableMatch = line.match(variable);
    const match = declared ?? functionMatch ?? variableMatch;
    if (!match) continue;
    const rawKind = declared?.[1];
    const kind: StructuralSymbolKind = rawKind === "class" || rawKind === "interface" || rawKind === "enum"
      || rawKind === "namespace" || rawKind === "type" ? rawKind : variableMatch ? "variable" : "function";
    const name = (declared?.[2] ?? functionMatch?.[1] ?? variableMatch?.[1]) as string;
    symbols.push({
      name,
      kind,
      signature: signatureAt(lines, index, language),
      startLine: index + 1,
      endLine: braceEnd(clean, index),
    });
  }
  assignParents(symbols);
  const containers = symbols.filter((symbol) => symbol.kind === "class" || symbol.kind === "interface");
  const methodPattern = /^\s*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*(constructor|[A-Za-z_$][\w$]*)\s*(?:<[^>{}]*>)?\s*\([^;{}]*\)\s*(?::[^;{]+)?\s*(?:[{]|;)/u;
  for (const parent of containers) {
    const declarationLine = clean[parent.startLine - 1] ?? "";
    let depth = [...declarationLine].reduce(
      (value, char) => value + (char === "{" ? 1 : char === "}" ? -1 : 0),
      0,
    );
    for (let index = parent.startLine; index < parent.endLine - 1; index++) {
      const line = clean[index] ?? "";
      if (depth === 1) {
        const match = line.match(methodPattern);
        const name = match?.[1];
        if (name && !CONTROL_METHOD_NAMES.has(name) && !symbols.some((item) => item.startLine === index + 1)) {
          symbols.push({
            name,
            kind: "method",
            signature: signatureAt(lines, index, language),
            parentSymbol: parent.name,
            startLine: index + 1,
            endLine: Math.min(parent.endLine, braceEnd(clean, index)),
          });
        }
      }
      for (const char of line) depth += char === "{" ? 1 : char === "}" ? -1 : 0;
    }
  }
  return symbols;
}

function parsePython(lines: readonly string[], clean: readonly string[]): MutableSymbol[] {
  const symbols: MutableSymbol[] = [];
  const pattern = /^(\s*)(?:(?:async)\s+)?(class|def)\s+([A-Za-z_][\w]*)/u;
  const stack: Array<{ indent: number; symbol: MutableSymbol }> = [];
  for (let index = 0; index < clean.length; index++) {
    const match = (clean[index] ?? "").match(pattern);
    if (!match) continue;
    const indent = match[1]?.length ?? 0;
    while (stack.length > 0 && (stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
    const parent = stack.at(-1)?.symbol;
    const name = match[3] as string;
    const kind: StructuralSymbolKind = match[2] === "class" ? "class" : parent ? "method" : "function";
    const symbol: MutableSymbol = {
      name,
      kind,
      signature: signatureAt(lines, index, "python"),
      ...(parent ? { parentSymbol: parent.name } : {}),
      startLine: index + 1,
      endLine: pythonEnd(clean, index),
    };
    symbols.push(symbol);
    stack.push({ indent, symbol });
  }
  return symbols;
}

function parseGo(lines: readonly string[], clean: readonly string[]): MutableSymbol[] {
  const symbols: MutableSymbol[] = [];
  const typePattern = /^\s*type\s+([A-Za-z_][\w]*)\s+(struct|interface)\b/u;
  const functionPattern = /^\s*func\s+(?:\(\s*\w+\s+\*?([A-Za-z_][\w]*)\s*\)\s*)?([A-Za-z_][\w]*)\s*\(/u;
  for (let index = 0; index < clean.length; index++) {
    const typeMatch = (clean[index] ?? "").match(typePattern);
    const functionMatch = (clean[index] ?? "").match(functionPattern);
    if (!typeMatch && !functionMatch) continue;
    const parentSymbol = functionMatch?.[1];
    const name = (typeMatch?.[1] ?? functionMatch?.[2]) as string;
    symbols.push({
      name,
      kind: typeMatch ? (typeMatch[2] === "struct" ? "struct" : "interface") : parentSymbol ? "method" : "function",
      signature: signatureAt(lines, index, "go"),
      ...(parentSymbol ? { parentSymbol } : {}),
      startLine: index + 1,
      endLine: braceEnd(clean, index),
    });
  }
  return symbols;
}

function qualifiedName(symbol: MutableSymbol, all: readonly MutableSymbol[]): string {
  const parent = symbol.parentSymbol;
  if (!parent) return symbol.name;
  const parentSymbol = all.find((candidate) => candidate.name === parent && candidate !== symbol);
  return `${parentSymbol ? qualifiedName(parentSymbol, all) : parent}.${symbol.name}`;
}

export class DeterministicRegexSymbolParser implements SymbolParser {
  readonly id = REGEX_SYMBOL_PARSER_VERSION;
  readonly languages = SUPPORTED_LANGUAGES;

  parse(input: SymbolParserInput): ParsedSymbolDocument | undefined {
    const language = input.language?.toLowerCase();
    if (!language || !this.languages.includes(language as typeof SUPPORTED_LANGUAGES[number])) return undefined;
    const lines = input.content.split(/\r?\n/u);
    const clean = lexicalLines(input.content, language);
    if (!clean) return undefined;
    const imports = importsFor(lines, language);
    const mutable = language === "python"
      ? parsePython(lines, clean)
      : language === "go"
        ? parseGo(lines, clean)
        : parseTypeScript(lines, clean, language);
    const symbols = mutable.slice(0, 200).map((symbol): ParsedSymbol => ({
      name: symbol.name,
      qualifiedName: qualifiedName(symbol, mutable),
      kind: symbol.kind,
      signature: symbol.signature,
      ...(symbol.parentSymbol ? { parentSymbol: symbol.parentSymbol } : {}),
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      imports: [...imports],
      references: referencesFor(lines, symbol, imports),
    }));
    return { parserId: this.id, language, imports, symbols };
  }
}

export class SymbolParserChain implements SymbolParser {
  readonly id: string;
  readonly languages: readonly string[];

  constructor(private readonly parsers: readonly SymbolParser[]) {
    if (parsers.length === 0) throw new Error("SymbolParserChain requires at least one parser");
    this.id = parsers.map((parser) => parser.id).join("+");
    this.languages = unique(parsers.flatMap((parser) => parser.languages), 64);
  }

  parse(input: SymbolParserInput): ParsedSymbolDocument | undefined {
    for (const parser of this.parsers) {
      try {
        const parsed = parser.parse(input);
        if (parsed) return parsed;
      } catch {
        // Parser adapters are optional derived-index helpers. Continue to the deterministic fallback.
      }
    }
    return undefined;
  }
}

export const DEFAULT_SYMBOL_PARSER: SymbolParser = new DeterministicRegexSymbolParser();

export function withRegexSymbolFallback(primary?: SymbolParser): SymbolParser {
  return primary
    ? new SymbolParserChain([primary, DEFAULT_SYMBOL_PARSER])
    : DEFAULT_SYMBOL_PARSER;
}

export function stableSymbolId(input: SymbolParserInput, symbol: ParsedSymbol): string {
  return sha256([
    input.projectPath,
    input.filePath,
    input.fileHash,
    symbol.startLine,
    symbol.endLine,
    symbol.kind,
    symbol.qualifiedName,
  ].join("\0"));
}

export function extractLegacySymbols(content: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /\b(?:class|interface|enum|namespace|record|struct|trait|type)\s+([A-Za-z_$][\w$]*)/gu,
    /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gu,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/gmu,
    /^\s*(?:def|fn|func)\s+([A-Za-z_$][\w$]*)/gmu,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      if (match[1]) symbols.add(match[1]);
      if (symbols.size >= 128) return [...symbols];
    }
  }
  return [...symbols];
}

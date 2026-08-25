import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectKnowledgeConfig } from "../config/config.ts";
import { estimateTextTokens } from "../core/token-estimator.ts";
import type {
  ProjectKnowledgeRepository,
  StoredProjectFile,
  StoredProjectSnippet,
} from "../persistence/repositories/project-knowledge-repository.ts";
import { sha256 } from "../shared/hash.ts";
import { readGitProjectState, type GitProjectState } from "./git-state.ts";
import {
  extractLegacySymbols,
  stableSymbolId,
  withRegexSymbolFallback,
  type SymbolParser,
  type SymbolParserInput,
} from "./symbol-parser.ts";

const IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".pi", ".cache", ".idea", ".vscode",
  "node_modules", "vendor", "dist", "build", "coverage", "target",
  "bin", "obj", ".next", ".nuxt", ".venv", "venv", "__pycache__",
]);
const BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".bmp", ".class", ".db", ".dll", ".dylib",
  ".eot", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg",
  ".mov", ".mp3", ".mp4", ".o", ".otf", ".pdf", ".png", ".pyc",
  ".so", ".sqlite", ".tar", ".tgz", ".ttf", ".wav", ".webm",
  ".webp", ".woff", ".woff2", ".xz", ".zip",
]);
const LOCK_FILES = new Set([
  "bun.lock", "bun.lockb", "cargo.lock", "composer.lock", "flake.lock",
  "package-lock.json", "packages.lock.json", "pnpm-lock.yaml", "poetry.lock",
  "yarn.lock",
]);
const SECRET_FILE_NAMES = new Set([
  ".env", ".netrc", ".npmrc", ".pypirc", "credentials", "credentials.json",
  "credentials.yaml", "credentials.yml", "id_dsa", "id_ed25519", "id_rsa",
  "secrets.json", "secrets.yaml", "secrets.yml",
]);

export interface ProjectIndexSyncResult {
  mode: "full" | "incremental";
  discoveredFiles: number;
  indexedFiles: number;
  unchangedFiles: number;
  deletedFiles: number;
  skippedLarge: number;
  skippedBinary: number;
  skippedSensitive: number;
  skippedLimit: number;
  currentSnippets: number;
  staleSnippets: number;
  durationMs: number;
  git: GitProjectState;
}

interface FileCandidate {
  path: string;
  tracked: boolean;
}

interface IndexedContent {
  file: StoredProjectFile;
  snippets: StoredProjectSnippet[];
}

function normalizeRelative(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

function pathWithinRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function ignoredPath(path: string): boolean {
  const segments = path.split("/");
  return segments.some((segment) => IGNORED_DIRECTORIES.has(segment));
}

function sensitiveName(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (SECRET_FILE_NAMES.has(name) || name.startsWith(".env.")) return true;
  return /\.(?:key|pem|p12|pfx|jks|keystore)$/iu.test(name);
}

function generatedOrBinaryName(path: string): boolean {
  const name = basename(path).toLowerCase();
  return BINARY_EXTENSIONS.has(extname(name))
    || LOCK_FILES.has(name)
    || /\.min\.(?:css|js)$/u.test(name)
    || name.endsWith(".map");
}

function likelyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) controls++;
  }
  return sample.length > 0 && controls / sample.length > 0.05;
}

function likelySecretContent(text: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text)) return true;
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(text)) return true;
  if (/\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/u.test(text)) return true;
  const assignments = text.matchAll(/\b(?:api[_-]?key|authorization|client[_-]?secret|password|private[_-]?key|secret|token)\b\s*[:=]\s*["']([^"'\r\n]{12,})["']/giu);
  for (const match of assignments) {
    const value = (match[1] ?? "").trim();
    if (!/(?:example|placeholder|redacted|dummy|changeme|your[_-]|process\.env|\$\{|<[^>]+>)/iu.test(value)) return true;
  }
  return false;
}

function languageFor(path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  const names: Record<string, string> = {
    ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cs": "csharp", ".css": "css",
    ".go": "go", ".h": "c", ".hpp": "cpp", ".html": "html", ".java": "java",
    ".js": "javascript", ".json": "json", ".jsx": "javascript", ".kt": "kotlin",
    ".md": "markdown", ".php": "php", ".proto": "protobuf", ".py": "python",
    ".rb": "ruby", ".rs": "rust", ".sh": "shell", ".sql": "sql", ".swift": "swift",
    ".toml": "toml", ".ts": "typescript", ".tsx": "typescript", ".xml": "xml",
    ".yaml": "yaml", ".yml": "yaml", ".vue": "vue", ".svelte": "svelte",
  };
  return names[extension];
}

function textSnippetsFor(
  projectPath: string,
  filePath: string,
  fileHash: string,
  content: string,
  config: ProjectKnowledgeConfig,
  indexedAt: number,
): StoredProjectSnippet[] {
  const lines = content.split(/\r?\n/u);
  const step = Math.max(1, config.snippetLines - config.snippetOverlapLines);
  const snippets: StoredProjectSnippet[] = [];
  for (let start = 0; start < lines.length && snippets.length < 200; start += step) {
    const endExclusive = Math.min(lines.length, start + config.snippetLines);
    let snippetContent = lines.slice(start, endExclusive).join("\n");
    if (snippetContent.length > 20_000) snippetContent = `${snippetContent.slice(0, 20_000)}\n[DS4 snippet truncated]`;
    if (!snippetContent.trim()) {
      if (endExclusive >= lines.length) break;
      continue;
    }
    const startLine = start + 1;
    const endLine = endExclusive;
    const snippetId = sha256(`${projectPath}\0${filePath}\0${fileHash}\0${startLine}\0${endLine}`);
    snippets.push({
      snippetId,
      projectPath,
      filePath,
      fileHash,
      startLine,
      endLine,
      content: snippetContent,
      symbols: extractLegacySymbols(snippetContent),
      tokenEstimate: estimateTextTokens(snippetContent) + 48,
      stale: false,
      indexedAt,
      chunkKind: "text",
      imports: [],
      references: [],
    });
    if (endExclusive >= lines.length) break;
  }
  return snippets;
}

function snippetsFor(
  projectPath: string,
  filePath: string,
  fileHash: string,
  content: string,
  language: string | undefined,
  config: ProjectKnowledgeConfig,
  indexedAt: number,
  parser: SymbolParser,
): StoredProjectSnippet[] {
  if (/\[\/?ds4:(?:normal|sensitive|local-only)\]/iu.test(content)) {
    return textSnippetsFor(projectPath, filePath, fileHash, content, config, indexedAt);
  }
  const input: SymbolParserInput = { projectPath, filePath, fileHash, content, ...(language ? { language } : {}) };
  const parsed = parser.parse(input);
  if (!parsed || parsed.symbols.length === 0) {
    return textSnippetsFor(projectPath, filePath, fileHash, content, config, indexedAt);
  }

  const lines = content.split(/\r?\n/u);
  const snippets: StoredProjectSnippet[] = [];
  for (const symbol of parsed.symbols) {
    const symbolId = stableSymbolId(input, symbol);
    const step = Math.max(1, config.snippetLines - config.snippetOverlapLines);
    for (let startLine = symbol.startLine; startLine <= symbol.endLine && snippets.length < 200; startLine += step) {
      const endLine = Math.min(symbol.endLine, startLine + config.snippetLines - 1);
      let snippetContent = lines.slice(startLine - 1, endLine).join("\n");
      if (snippetContent.length > 20_000) snippetContent = `${snippetContent.slice(0, 20_000)}\n[DS4 snippet truncated]`;
      if (!snippetContent.trim()) break;
      const snippetId = sha256(`${symbolId}\0${startLine}\0${endLine}`);
      snippets.push({
        snippetId,
        projectPath,
        filePath,
        fileHash,
        startLine,
        endLine,
        content: snippetContent,
        symbols: [symbol.name, symbol.qualifiedName],
        tokenEstimate: estimateTextTokens(snippetContent) + 64,
        stale: false,
        indexedAt,
        chunkKind: "symbol",
        parserId: parsed.parserId,
        symbolId,
        symbolName: symbol.name,
        qualifiedName: symbol.qualifiedName,
        symbolKind: symbol.kind,
        signature: symbol.signature,
        ...(symbol.parentSymbol ? { parentSymbol: symbol.parentSymbol } : {}),
        imports: [...symbol.imports],
        references: [...symbol.references],
      });
      if (endLine >= symbol.endLine) break;
    }
    if (snippets.length >= 200) break;
  }
  return snippets.length > 0
    ? snippets
    : textSnippetsFor(projectPath, filePath, fileHash, content, config, indexedAt);
}

export class ProjectFileIndexer {
  readonly projectPath: string;
  private lastGit: GitProjectState;
  private readonly symbolParser: SymbolParser;

  constructor(
    projectPath: string,
    private readonly repository: ProjectKnowledgeRepository,
    private readonly config: ProjectKnowledgeConfig,
    private readonly now: () => number = Date.now,
    symbolParser?: SymbolParser,
  ) {
    this.projectPath = realpathSync(projectPath);
    this.symbolParser = withRegexSymbolFallback(symbolParser);
    this.lastGit = {
      available: false,
      dirty: false,
      changedFiles: [],
      trackedFiles: new Set(),
      untrackedFiles: new Set(),
    };
  }

  sync(force = false, checkpoint: () => void = () => {}): ProjectIndexSyncResult {
    const startedAt = this.now();
    const indexedAt = this.now();
    const git = readGitProjectState(this.projectPath);
    checkpoint();
    this.lastGit = git;
    this.repository.saveState({
      projectPath: this.projectPath,
      ...(git.root ? { gitRoot: git.root } : {}),
      ...(git.branch ? { gitBranch: git.branch } : {}),
      ...(git.head ? { gitHead: git.head } : {}),
      dirty: git.dirty,
      changedFiles: git.changedFiles.slice(0, 1_000),
      indexedAt,
    }, checkpoint);

    const candidates = this.discover(git);
    const existing = new Map(this.repository.listFiles(this.projectPath).map((file) => [file.filePath, file]));
    const present = new Set<string>();
    let indexedFiles = 0;
    let unchangedFiles = 0;
    let skippedLarge = 0;
    let skippedBinary = 0;
    let skippedSensitive = 0;
    let skippedLimit = 0;
    let acceptedBytes = 0;

    for (const candidate of candidates) {
      checkpoint();
      if (present.size >= this.config.maxFiles) {
        skippedLimit++;
        continue;
      }
      const absolute = resolve(this.projectPath, candidate.path);
      if (!pathWithinRoot(this.projectPath, absolute)) continue;
      let stat;
      try {
        stat = lstatSync(absolute);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.size > this.config.maxFileBytes) {
        skippedLarge++;
        continue;
      }
      if (acceptedBytes + stat.size > this.config.maxTotalBytes) {
        skippedLimit++;
        continue;
      }
      present.add(candidate.path);
      acceptedBytes += stat.size;
      const previous = existing.get(candidate.path);
      const modified = git.changedFiles.includes(candidate.path) || !candidate.tracked;
      if (!force && previous?.status === "current" && previous.sizeBytes === stat.size && previous.mtimeMs === stat.mtimeMs
        && previous.modified === modified && previous.gitCommit === git.head) {
        unchangedFiles++;
        continue;
      }

      const indexed = this.readAndIndex(
        candidate,
        stat.mtimeMs,
        stat.size,
        modified,
        git.head,
        indexedAt,
        checkpoint,
      );
      if (indexed === "binary") skippedBinary++;
      else if (indexed === "sensitive") skippedSensitive++;
      else if (indexed) indexedFiles++;
      if (indexed !== true) {
        this.repository.markDeleted(this.projectPath, [candidate.path], indexedAt, checkpoint);
      }
    }

    const deleted = [...existing.values()]
      .filter((file) => file.status === "current" && !present.has(file.filePath))
      .map((file) => file.filePath);
    checkpoint();
    this.repository.markDeleted(this.projectPath, deleted, indexedAt, checkpoint);
    const stats = this.repository.getStats(this.projectPath);
    return {
      mode: force || existing.size === 0 ? "full" : "incremental",
      discoveredFiles: candidates.length,
      indexedFiles,
      unchangedFiles,
      deletedFiles: deleted.length,
      skippedLarge,
      skippedBinary,
      skippedSensitive,
      skippedLimit,
      currentSnippets: stats.currentSnippets,
      staleSnippets: stats.staleSnippets,
      durationMs: Math.max(0, this.now() - startedAt),
      git,
    };
  }

  validateCurrent(
    filePath: string,
    expectedHash: string,
    checkpoint: () => void = () => {},
  ): "current" | "reindexed" | "deleted" | "excluded" {
    const normalized = normalizeRelative(filePath);
    if (!normalized || ignoredPath(normalized) || sensitiveName(normalized) || generatedOrBinaryName(normalized)) return "excluded";
    const absolute = resolve(this.projectPath, normalized);
    if (!pathWithinRoot(this.projectPath, absolute)) return "excluded";
    let stat;
    let buffer: Buffer;
    try {
      stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.config.maxFileBytes) throw new Error("not indexable");
      buffer = readFileSync(absolute);
    } catch {
      this.repository.markDeleted(this.projectPath, [normalized], this.now(), checkpoint);
      return "deleted";
    }
    if (likelyBinary(buffer)) {
      this.repository.markDeleted(this.projectPath, [normalized], this.now(), checkpoint);
      return "excluded";
    }
    const contentHash = sha256(buffer);
    if (contentHash === expectedHash) return "current";
    const text = buffer.toString("utf8");
    if (likelySecretContent(text)) {
      this.repository.markDeleted(this.projectPath, [normalized], this.now(), checkpoint);
      return "excluded";
    }
    const tracked = this.lastGit.trackedFiles.has(normalized);
    const modified = this.lastGit.changedFiles.includes(normalized) || !tracked;
    const indexedAt = this.now();
    const language = languageFor(normalized);
    this.repository.replaceFile(
      {
        projectPath: this.projectPath,
        filePath: normalized,
        contentHash,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        ...(language ? { language } : {}),
        ...(this.lastGit.head ? { gitCommit: this.lastGit.head } : {}),
        modified,
        tracked,
        status: "current",
        indexedAt,
      },
      snippetsFor(
        this.projectPath,
        normalized,
        contentHash,
        text,
        language,
        this.config,
        indexedAt,
        this.symbolParser,
      ),
      checkpoint,
    );
    return "reindexed";
  }

  private readAndIndex(
    candidate: FileCandidate,
    mtimeMs: number,
    sizeBytes: number,
    modified: boolean,
    gitHead: string | undefined,
    indexedAt: number,
    checkpoint: () => void,
  ): true | "binary" | "sensitive" | false {
    const absolute = resolve(this.projectPath, candidate.path);
    let buffer: Buffer;
    try {
      buffer = readFileSync(absolute);
    } catch {
      return false;
    }
    if (likelyBinary(buffer)) return "binary";
    const text = buffer.toString("utf8");
    const replacementCharacters = text.match(/\uFFFD/gu)?.length ?? 0;
    if (replacementCharacters > Math.max(2, text.length / 200)) return "binary";
    if (likelySecretContent(text)) return "sensitive";
    const contentHash = sha256(buffer);
    const language = languageFor(candidate.path);
    this.repository.replaceFile(
      {
        projectPath: this.projectPath,
        filePath: candidate.path,
        contentHash,
        sizeBytes,
        mtimeMs,
        ...(language ? { language } : {}),
        ...(gitHead ? { gitCommit: gitHead } : {}),
        modified,
        tracked: candidate.tracked,
        status: "current",
        indexedAt,
      },
      snippetsFor(
        this.projectPath,
        candidate.path,
        contentHash,
        text,
        language,
        this.config,
        indexedAt,
        this.symbolParser,
      ),
      checkpoint,
    );
    return true;
  }

  private discover(git: GitProjectState): FileCandidate[] {
    const candidates = new Map<string, FileCandidate>();
    const limit = this.config.maxFiles;
    if (git.available) {
      for (const path of [...git.trackedFiles].sort()) {
        this.addCandidate(candidates, path, true);
        if (candidates.size >= limit) break;
      }
      if (candidates.size < limit) {
        for (const path of [...git.untrackedFiles].sort()) {
          this.addCandidate(candidates, path, false);
          if (candidates.size >= limit) break;
        }
      }
      return [...candidates.values()].sort((left, right) => left.path.localeCompare(right.path));
    }

    let visitedDirectories = 0;
    const visit = (directory: string, prefix: string): void => {
      if (candidates.size >= limit || visitedDirectories >= limit) return;
      visitedDirectories++;
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (candidates.size >= limit || visitedDirectories >= limit) break;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name), path);
          continue;
        }
        if (entry.isFile()) this.addCandidate(candidates, path, false);
      }
    };
    visit(this.projectPath, "");
    return [...candidates.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  private addCandidate(target: Map<string, FileCandidate>, rawPath: string, tracked: boolean): void {
    const path = normalizeRelative(rawPath);
    if (!path || ignoredPath(path) || sensitiveName(path) || generatedOrBinaryName(path)) return;
    target.set(path, { path, tracked });
  }
}

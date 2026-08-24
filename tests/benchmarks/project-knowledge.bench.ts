import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, bench } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { ContextDatabase } from "../../src/persistence/sqlite.ts";
import { ProjectKnowledgeManager } from "../../src/project/project-knowledge.ts";

let root = "";
let database: ContextDatabase;
let manager: ProjectKnowledgeManager;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ds4-project-bench-"));
  const source = join(root, "src");
  mkdirSync(source, { recursive: true });
  for (let index = 0; index < 5_000; index++) {
    writeFileSync(
      join(source, `Module${String(index).padStart(4, "0")}.ts`),
      `export function UniqueSymbol${index}() { return ${index}; }\n`,
    );
  }
  database = ContextDatabase.open(":memory:");
  manager = new ProjectKnowledgeManager(
    root,
    database.projectKnowledge,
    { ...DEFAULT_CONFIG.project, maxFiles: 6_000, maxTotalBytes: 100_000_000 },
    DEFAULT_CONFIG.context.maxProjectTokens,
  );
  manager.sync();
});

afterAll(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

bench("exact path/symbol plus FTS over 5k project files", () => {
  manager.retrieve("Inspect `UniqueSymbol4999` in `src/Module4999.ts`.", Date.now());
}, { time: 1_000, warmupTime: 250 });

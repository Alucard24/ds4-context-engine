import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "ds4-context-core/shared/hash";

/** Kernel-backed per-source writer lock. NOT the rebuildable history index or a journal authority. */
export function acquireRebaseLock(sourceFile: string): () => void {
  const canonical = realpathSync.native(sourceFile);
  const root = join(dirname(canonical), ".ds4-rebase", "locks");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const database = new DatabaseSync(join(root, `${sha256(key)}.sqlite`));
  try {
    database.exec("PRAGMA busy_timeout = 200; CREATE TABLE IF NOT EXISTS lock_state (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE");
  } catch {
    database.close(); throw new Error("rebase-busy");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { database.exec("ROLLBACK"); } finally { database.close(); }
  };
}

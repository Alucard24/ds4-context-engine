import type { DatabaseSync } from "node:sqlite";
import { SqliteWriteCoordinator } from "../write-coordinator.ts";
import type { RebaseCheckpoint, RebaseLink, RebaseOperation } from "../../rebase/rebase-types.ts";

/** Projections only. Every payload must first be verified against its canonical JSONL/journal. */
export class RebaseRepository {
  constructor(private readonly db: DatabaseSync, private readonly writes = new SqliteWriteCoordinator(db)) {}
  project(targetSessionId: string, checkpoint: RebaseCheckpoint, link: RebaseLink): void {
    this.writes.transaction("rebase.project", () => {
      this.db.prepare(`INSERT OR REPLACE INTO rebase_checkpoints(checkpoint_id, session_id, payload_json) VALUES (?, ?, ?)`)
        .run(checkpoint.id, targetSessionId, JSON.stringify(checkpoint));
      this.db.prepare(`INSERT OR REPLACE INTO session_lineage(target_session_id, source_session_id, source_leaf_id, checkpoint_id, payload_json)
        VALUES (?, ?, ?, ?, ?)`).run(targetSessionId, link.sourceSessionId, link.sourceLeafId, checkpoint.id, JSON.stringify(link));
    });
  }
  projectOperation(operation: RebaseOperation): void {
    this.writes.transaction("rebase.operation", () => {
      this.db.prepare(`INSERT OR REPLACE INTO rebase_operations(operation_id, phase, payload_json) VALUES (?, ?, ?)`)
        .run(operation.id, operation.phase, JSON.stringify(operation));
    });
  }
  clearSession(sessionId: string): void {
    if (!this.db.prepare("SELECT 1 FROM rebase_checkpoints WHERE session_id = ? UNION ALL SELECT 1 FROM session_lineage WHERE target_session_id = ? LIMIT 1").get(sessionId, sessionId)) return;
    this.writes.transaction("rebase.clear-session", () => {
      this.db.prepare("DELETE FROM session_lineage WHERE target_session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM rebase_checkpoints WHERE session_id = ?").run(sessionId);
    });
  }
}

import type { DatabaseSync } from "node:sqlite";
import { SqliteWriteCoordinator } from "../write-coordinator.ts";

export interface ResourceLease {
  resourceType: string;
  resourceKey: string;
  ownerId: string;
  fencingToken: number;
  acquiredAt: number;
  expiresAt: number;
}

interface LeaseRow {
  resource_type: string;
  resource_key: string;
  owner_id: string;
  fencing_token: number;
  acquired_at: number;
  expires_at: number;
}

function leaseFromRow(row: LeaseRow): ResourceLease {
  return {
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    ownerId: row.owner_id,
    fencingToken: row.fencing_token,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

function validIdentity(value: string): boolean {
  return value.trim() === value && value.length > 0 && value.length <= 4_096;
}

function validateRequest(resourceType: string, resourceKey: string, ownerId: string, at: number): void {
  if (!validIdentity(resourceType)) throw new Error("Lease resourceType must be a non-empty trimmed string");
  if (!validIdentity(resourceKey)) throw new Error("Lease resourceKey must be a non-empty trimmed string");
  if (!validIdentity(ownerId)) throw new Error("Lease ownerId must be a non-empty trimmed string");
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("Lease timestamp must be a non-negative integer");
}

function validateDuration(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 86_400_000) {
    throw new Error("Lease durationMs must be an integer between 1 and 86400000");
  }
}

export class LeaseRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly writes = new SqliteWriteCoordinator(database),
  ) {}

  acquire(
    resourceType: string,
    resourceKey: string,
    ownerId: string,
    acquiredAt: number,
    durationMs: number,
  ): ResourceLease | undefined {
    validateRequest(resourceType, resourceKey, ownerId, acquiredAt);
    validateDuration(durationMs);
    const expiresAt = acquiredAt + durationMs;
    if (!Number.isSafeInteger(expiresAt)) throw new Error("Lease expiry exceeds the safe integer range");

    return this.writes.execute("lease-acquire", () => {
      const row = this.database.prepare(`
        INSERT INTO resource_leases(
          resource_type, resource_key, owner_id, fencing_token, acquired_at, expires_at
        ) VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(resource_type, resource_key) DO UPDATE SET
          owner_id = excluded.owner_id,
          fencing_token = CASE
            WHEN resource_leases.owner_id = excluded.owner_id THEN resource_leases.fencing_token
            ELSE resource_leases.fencing_token + 1
          END,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
        WHERE resource_leases.owner_id = excluded.owner_id
          OR resource_leases.expires_at <= excluded.acquired_at
        RETURNING resource_type, resource_key, owner_id, fencing_token, acquired_at, expires_at
      `).get(resourceType, resourceKey, ownerId, acquiredAt, expiresAt) as LeaseRow | undefined;
      return row ? leaseFromRow(row) : undefined;
    });
  }

  renew(lease: ResourceLease, renewedAt: number, durationMs: number): ResourceLease | undefined {
    validateRequest(lease.resourceType, lease.resourceKey, lease.ownerId, renewedAt);
    validateDuration(durationMs);
    const expiresAt = Math.max(lease.expiresAt, renewedAt + durationMs);
    if (!Number.isSafeInteger(expiresAt)) throw new Error("Lease expiry exceeds the safe integer range");

    return this.writes.execute("lease-renew", () => {
      const row = this.database.prepare(`
        UPDATE resource_leases
        SET expires_at = ?
        WHERE resource_type = ? AND resource_key = ? AND owner_id = ?
          AND fencing_token = ? AND expires_at > ?
        RETURNING resource_type, resource_key, owner_id, fencing_token, acquired_at, expires_at
      `).get(
        expiresAt,
        lease.resourceType,
        lease.resourceKey,
        lease.ownerId,
        lease.fencingToken,
        renewedAt,
      ) as LeaseRow | undefined;
      return row ? leaseFromRow(row) : undefined;
    });
  }

  isHeld(lease: ResourceLease, at: number): boolean {
    if (!Number.isSafeInteger(at) || at < 0) return false;
    return this.database.prepare(`
      SELECT 1 AS held FROM resource_leases
      WHERE resource_type = ? AND resource_key = ? AND owner_id = ?
        AND fencing_token = ? AND expires_at > ?
    `).get(
      lease.resourceType,
      lease.resourceKey,
      lease.ownerId,
      lease.fencingToken,
      at,
    ) !== undefined;
  }

  release(lease: ResourceLease): boolean {
    return this.writes.execute("lease-release", () => {
      const result = this.database.prepare(`
        DELETE FROM resource_leases
        WHERE resource_type = ? AND resource_key = ? AND owner_id = ? AND fencing_token = ?
      `).run(lease.resourceType, lease.resourceKey, lease.ownerId, lease.fencingToken);
      return result.changes === 1;
    });
  }

  get(resourceType: string, resourceKey: string): ResourceLease | undefined {
    if (!validIdentity(resourceType) || !validIdentity(resourceKey)) return undefined;
    const row = this.database.prepare(`
      SELECT resource_type, resource_key, owner_id, fencing_token, acquired_at, expires_at
      FROM resource_leases WHERE resource_type = ? AND resource_key = ?
    `).get(resourceType, resourceKey) as LeaseRow | undefined;
    return row ? leaseFromRow(row) : undefined;
  }

  deleteExpired(expiredAt: number): number {
    if (!Number.isSafeInteger(expiredAt) || expiredAt < 0) return 0;
    return this.writes.execute("lease-delete-expired", () => Number(this.database.prepare(
      "DELETE FROM resource_leases WHERE expires_at <= ?",
    ).run(expiredAt).changes));
  }
}

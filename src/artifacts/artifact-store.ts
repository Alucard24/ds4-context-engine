import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "../shared/hash.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface StoredArtifactObject {
  sha256: string;
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  verifiedAt: number;
  deduplicated: boolean;
  repaired: boolean;
}

export type ArtifactVerification =
  | { status: "available"; content: Buffer; verifiedAt: number }
  | { status: "missing"; verifiedAt: number }
  | { status: "corrupt"; verifiedAt: number; actualSha256: string };

function bestEffortChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (!["ENOSYS", "EPERM", "EINVAL"].includes(code)) throw error;
  }
}

export class FileArtifactStore {
  readonly root: string;

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    private readonly idGenerator: () => string = randomUUID,
  ) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    bestEffortChmod(this.root, 0o700);
  }

  put(content: Uint8Array, mimeType: string): StoredArtifactObject {
    const buffer = Buffer.from(content);
    const digest = sha256(buffer);
    const directory = join(this.root, digest.slice(0, 2));
    const filePath = join(directory, digest);
    const createdAt = this.now();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    bestEffortChmod(directory, 0o700);

    let repaired = false;
    let quarantinePath: string | undefined;
    if (existsSync(filePath)) {
      const existing = this.verify(digest);
      if (existing.status === "available") {
        return {
          sha256: digest,
          filePath,
          mimeType,
          sizeBytes: buffer.byteLength,
          createdAt,
          verifiedAt: existing.verifiedAt,
          deduplicated: true,
          repaired: false,
        };
      }
      quarantinePath = `${filePath}.corrupt-${this.idGenerator().replace(/[^A-Za-z0-9_-]/gu, "")}`;
      renameSync(filePath, quarantinePath);
      repaired = true;
    }

    const temporaryPath = join(directory, `.tmp-${this.idGenerator().replace(/[^A-Za-z0-9_-]/gu, "")}`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, buffer);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, filePath);
      bestEffortChmod(filePath, 0o600);
      if (quarantinePath) rmSync(quarantinePath, { force: true });
    } catch (error) {
      if (quarantinePath && existsSync(quarantinePath) && !existsSync(filePath)) {
        renameSync(quarantinePath, filePath);
      }
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporaryPath, { force: true });
    }

    return {
      sha256: digest,
      filePath,
      mimeType,
      sizeBytes: buffer.byteLength,
      createdAt,
      verifiedAt: this.now(),
      deduplicated: false,
      repaired,
    };
  }

  verify(digest: string, maxBytes?: number): ArtifactVerification {
    const filePath = this.pathFor(digest);
    const verifiedAt = this.now();
    if (!existsSync(filePath)) return { status: "missing", verifiedAt };
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: "corrupt", verifiedAt, actualSha256: "non-regular-file" };
    if (maxBytes !== undefined && stat.size > maxBytes) {
      throw new Error(`Artifact ${digest} exceeds the ${maxBytes} byte read limit`);
    }
    const content = readFileSync(filePath);
    const actualSha256 = sha256(content);
    if (actualSha256 !== digest) return { status: "corrupt", verifiedAt, actualSha256 };
    return { status: "available", content, verifiedAt };
  }

  remove(digest: string): void {
    rmSync(this.pathFor(digest), { force: true });
  }

  pathFor(digest: string): string {
    if (!SHA256_PATTERN.test(digest)) throw new Error("Artifact SHA-256 must be 64 lowercase hexadecimal characters");
    return join(this.root, digest.slice(0, 2), digest);
  }
}

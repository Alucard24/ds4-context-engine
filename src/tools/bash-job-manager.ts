import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export const MAX_RUNNING_JOBS = 4;
export const MAX_RETAINED_JOBS = 16;
export const MAX_JOB_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_JOB_TIMEOUT_SECONDS = 300;
export const MAX_JOB_TIMEOUT_SECONDS = 3600;

export interface JobOwner { sessionId: string; entryId: string | null }
export interface JobScope { sessionId: string; branchIds: ReadonlySet<string>; leafId: string | null }
export type JobStatus = "running" | "exited" | "failed" | "stopped" | "timed-out" | "output-limit" | "log-error";
export interface JobSnapshot {
  id: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  outputBytes: number;
  outputPath: string;
  head?: string;
  tail?: string;
  outputTruncated: boolean;
}
interface Job {
  owner: JobOwner;
  snapshot: JobSnapshot;
  controller: AbortController;
  stopReason?: JobStatus;
  done: Promise<void>;
}

/** Process-local registry. Pi owns platform-specific process-tree cancellation. */
export class BashJobManager {
  private jobs = new Map<string, Job>();
  private directory?: Promise<string>;
  private closed = false;

  constructor(private readonly operations: BashOperations, private readonly onFinish: () => void = () => {}) {}

  private visible(job: Job, scope: JobScope): boolean {
    return job.owner.sessionId === scope.sessionId
      && (job.owner.entryId === null ? scope.leafId === null : scope.branchIds.has(job.owner.entryId));
  }

  private find(id: string, scope: JobScope): Job {
    const job = this.jobs.get(id);
    if (!job || !this.visible(job, scope)) throw new Error("Job unavailable in this session/branch");
    return job;
  }

  async start(command: string, cwd: string, owner: JobOwner, timeout: number, signal?: AbortSignal): Promise<JobSnapshot> {
    if (!command.trim() || command.length > 32_768) throw new Error("Job command must contain 1-32768 characters");
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_JOB_TIMEOUT_SECONDS) throw new Error("Invalid job timeout");
    if (this.closed || signal?.aborted) throw new Error("Job start aborted");
    this.directory ??= (async () => {
      const directory = await mkdtemp(join(tmpdir(), "ds4-bash-jobs-"));
      try { await chmod(directory, 0o700); return directory; }
      catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    })();
    const directory = await this.directory;
    if (this.closed || signal?.aborted) throw new Error("Job start aborted");
    if ([...this.jobs.values()].filter((job) => job.snapshot.status === "running").length >= MAX_RUNNING_JOBS) {
      throw new Error(`At most ${MAX_RUNNING_JOBS} local jobs may run concurrently`);
    }
    if (this.jobs.size >= MAX_RETAINED_JOBS) {
      const oldest = [...this.jobs.values()].find((job) => job.snapshot.status !== "running");
      if (!oldest) throw new Error("Job registry is full");
      unlinkSync(oldest.snapshot.outputPath);
      this.jobs.delete(oldest.snapshot.id);
    }
    const id = randomUUID();
    const outputPath = join(directory, `${id}.log`);
    const fd = openSync(outputPath, "wx", 0o600);
    const job: Job = {
      owner: { ...owner }, controller: new AbortController(), done: Promise.resolve(),
      snapshot: { id, status: "running", startedAt: Date.now(), outputBytes: 0, outputPath, outputTruncated: false },
    };
    this.jobs.set(id, job);
    const abort = (reason: JobStatus) => {
      job.stopReason ??= reason;
      job.controller.abort();
    };
    job.done = Promise.resolve().then(async () => {
      try {
        const result = await this.operations.exec(command, cwd, {
          timeout,
          signal: job.controller.signal,
          onData: (data) => {
            if (job.stopReason || job.snapshot.status !== "running") return;
            const remaining = MAX_JOB_OUTPUT_BYTES - job.snapshot.outputBytes;
            const size = Math.min(remaining, data.length);
            try {
              let offset = 0;
              while (offset < size) {
                const written = writeSync(fd, data, offset, size - offset);
                if (written === 0) throw new Error("Zero-byte log write");
                offset += written;
                job.snapshot.outputBytes += written;
              }
              if (data.length >= remaining) {
                job.snapshot.outputTruncated = true;
                abort("output-limit");
              }
            } catch { abort("log-error"); }
          },
        });
        job.snapshot.exitCode = result.exitCode;
        job.snapshot.status = job.stopReason ?? "exited";
      } catch (error) {
        job.snapshot.status = job.stopReason
          ?? (error instanceof Error && error.message.startsWith("timeout:") ? "timed-out" : "failed");
      } finally {
        try { closeSync(fd); } catch { job.snapshot.status = "log-error"; }
        job.snapshot.endedAt = Date.now();
        try { this.onFinish(); } catch { /* Completion must not reject an unobserved promise. */ }
      }
    });
    return { ...job.snapshot };
  }

  list(scope: JobScope): JobSnapshot[] {
    return [...this.jobs.values()].filter((job) => this.visible(job, scope)).map((job) => ({ ...job.snapshot }));
  }

  status(id: string, scope: JobScope): JobSnapshot {
    const job = this.find(id, scope);
    const snapshot = { ...job.snapshot };
    const fd = openSync(snapshot.outputPath, "r");
    const read = (offset: number, size: number) => {
      const buffer = Buffer.alloc(size);
      return buffer.subarray(0, readSync(fd, buffer, 0, size, offset)).toString("utf8");
    };
    try {
      const headBytes = Math.min(512, snapshot.outputBytes);
      const tailStart = Math.max(headBytes, snapshot.outputBytes - 512);
      snapshot.head = read(0, headBytes);
      if (tailStart < snapshot.outputBytes) snapshot.tail = read(tailStart, snapshot.outputBytes - tailStart);
      snapshot.outputTruncated ||= tailStart > headBytes;
    } finally { closeSync(fd); }
    return snapshot;
  }

  async stop(id: string, scope: JobScope): Promise<JobSnapshot> {
    const job = this.find(id, scope);
    if (job.snapshot.status === "running") {
      job.stopReason ??= "stopped";
      job.controller.abort();
      await job.done;
    }
    return this.status(id, scope);
  }

  async stopInvisible(scope: JobScope): Promise<void> {
    const invisible = [...this.jobs.values()].filter((job) => !this.visible(job, scope));
    for (const job of invisible) {
      if (job.snapshot.status === "running") { job.stopReason ??= "stopped"; job.controller.abort(); }
    }
    await Promise.all(invisible.map((job) => job.done));
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) {
      if (job.snapshot.status === "running") { job.stopReason ??= "stopped"; job.controller.abort(); }
    }
    await Promise.all([...this.jobs.values()].map((job) => job.done));
    this.jobs.clear();
    const directory = await this.directory?.catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

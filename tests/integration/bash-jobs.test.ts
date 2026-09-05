import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { createLocalBashOperations, type BashOperations, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBashJobRegistration } from "../../src/extension/bash-job-tool.ts";
import { BashJobManager, MAX_JOB_OUTPUT_BYTES, MAX_RETAINED_JOBS, type JobScope } from "../../src/tools/bash-job-manager.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const owner = { sessionId: "session-a", entryId: "origin" };
const scope: JobScope = { sessionId: "session-a", branchIds: new Set(["origin", "current"]), leafId: "current" };
const sleeping: BashOperations = { exec: async (_command, _cwd, { signal }) => {
  await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
  throw new Error("aborted");
} };
function manager(operations = sleeping, onFinish = vi.fn()) {
  const jobs = new BashJobManager(operations, onFinish); cleanups.push(() => jobs.dispose()); return jobs;
}
async function settled(jobs: BashJobManager, id: string) {
  await vi.waitFor(() => expect(jobs.status(id, scope).status).not.toBe("running"), { timeout: 5000 });
  return jobs.status(id, scope);
}

function toolFixture(operations: BashOperations = sleeping) {
  let tool: ToolDefinition | undefined;
  let sources = [{ name: "bash", sourceInfo: { source: "builtin" } }];
  let active = ["bash"];
  const pi = { registerTool: vi.fn((value: ToolDefinition) => { tool = value; }),
    getAllTools: () => sources, getActiveTools: () => active, setActiveTools: (value: string[]) => { active = value; }, sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  const confirm = vi.fn(async () => true);
  const context = { cwd: tmpdir(), hasUI: true, isProjectTrusted: () => true, ui: { confirm, notify: vi.fn() },
    sessionManager: { getSessionId: () => "session-a", getLeafId: () => "origin", getBranch: () => [{ id: "origin" }] },
  } as unknown as ExtensionContext;
  const finish = vi.fn();
  const registration = createBashJobRegistration(pi, finish, operations);
  cleanups.push(() => registration.shutdown());
  const run = async (args: unknown, signal?: AbortSignal) => {
    const result = await tool!.execute("call", args, signal, undefined, context);
    const text = (result.content[0] as { text: string }).text;
    return JSON.parse(text.slice(text.indexOf("\n") + 1));
  };
  return { pi, context, confirm, finish, registration, run, active: () => active,
    sources: (value: typeof sources) => { sources = value; } };
}

describe("local bash job manager", () => {
  it("uses private files, opaque IDs, independent lifetime, and stops only owned jobs", async () => {
    const jobs = manager();
    const job = await jobs.start("sleep", tmpdir(), owner, 300);
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    if (process.platform !== "win32") {
      expect(statSync(job.outputPath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(job.outputPath)).mode & 0o777).toBe(0o700);
    }
    expect(jobs.list(scope)).toHaveLength(1);
    for (const foreign of [{ ...scope, sessionId: "other" }, { ...scope, branchIds: new Set(["sibling"]) }]) {
      expect(jobs.list(foreign)).toEqual([]);
      expect(() => jobs.status(job.id, foreign)).toThrow("unavailable");
      await expect(jobs.stop(job.id, foreign)).rejects.toThrow("unavailable");
    }
    expect((await jobs.stop(job.id, scope)).status).toBe("stopped");
    expect((await jobs.stop(job.id, scope)).status).toBe("stopped");
    await jobs.dispose();
    expect(existsSync(dirname(job.outputPath))).toBe(false);
  });

  it("enforces concurrency even on simultaneous starts and aborts pending starts", async () => {
    const jobs = manager();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => jobs.start("sleep", tmpdir(), owner, 300)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(jobs.list(scope)).toHaveLength(4);
    const controller = new AbortController(); controller.abort();
    await expect(jobs.start("sleep", tmpdir(), owner, 300, controller.signal)).rejects.toThrow("aborted");
    await jobs.dispose();
    await expect(jobs.start("sleep", tmpdir(), owner, 300)).rejects.toThrow("aborted");
  });

  it("cancels a start during directory creation without executing a command", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const jobs = manager({ exec });
    const abort = new AbortController();
    const pending = jobs.start("do not run", tmpdir(), owner, 300, abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(exec).not.toHaveBeenCalled();
    expect(jobs.list(scope)).toEqual([]);
  });

  it("disposes safely while the first start is still initializing", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const jobs = manager({ exec });
    const pending = jobs.start("do not run", tmpdir(), owner, 300);
    const closed = jobs.dispose();
    await expect(pending).rejects.toThrow("aborted");
    await closed;
    expect(exec).not.toHaveBeenCalled();
  });

  it("records executor failures without leaking unhandled rejections", async () => {
    const finish = vi.fn();
    const jobs = manager({ exec: async () => { throw new Error("executor failed"); } }, finish);
    const job = await jobs.start("failure", tmpdir(), owner, 300);
    expect(await settled(jobs, job.id)).toMatchObject({ status: "failed", outputBytes: 0 });
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("caps output, stops on overflow and bounds head/tail snapshots", async () => {
    const jobs = manager({ exec: async (_command, _cwd, { onData }) => {
      onData(Buffer.concat([Buffer.from("HEAD"), Buffer.alloc(MAX_JOB_OUTPUT_BYTES, 120)]));
      onData(Buffer.from("discarded"));
      return { exitCode: null };
    } });
    const job = await jobs.start("output", tmpdir(), owner, 300);
    const result = await settled(jobs, job.id);
    expect(result).toMatchObject({ status: "output-limit", outputBytes: MAX_JOB_OUTPUT_BYTES, outputTruncated: true });
    expect(result.head).toMatch(/^HEAD/);
    expect(result.head!.length + result.tail!.length).toBeLessThanOrEqual(1024);
    expect(statSync(result.outputPath).size).toBe(MAX_JOB_OUTPUT_BYTES);
  });

  it("evicts completed records/logs while preserving running jobs", async () => {
    const jobs = manager({ exec: async () => ({ exitCode: 0 }) });
    let firstPath = "";
    for (let i = 0; i <= MAX_RETAINED_JOBS; i++) {
      const job = await jobs.start("done", tmpdir(), owner, 300);
      if (i === 0) firstPath = job.outputPath;
      await settled(jobs, job.id);
    }
    expect(jobs.list(scope)).toHaveLength(MAX_RETAINED_JOBS);
    expect(existsSync(firstPath)).toBe(false);
  });

  it("stops jobs that become invisible after branch navigation", async () => {
    const jobs = manager();
    const parent = await jobs.start("parent", tmpdir(), owner, 300);
    const branch = await jobs.start("branch", tmpdir(), { ...owner, entryId: "current" }, 300);
    await jobs.stopInvisible({ ...scope, branchIds: new Set(["origin", "sibling"]), leafId: "sibling" });
    expect(jobs.status(parent.id, scope).status).toBe("running");
    expect(jobs.status(branch.id, scope).status).toBe("stopped");
  });

  it("runs real native local operations, captures exit codes and cleans up on stop/timeout", async () => {
    const jobs = manager(createLocalBashOperations());
    const done = await jobs.start("printf 'hello native'; exit 7", tmpdir(), owner, 5);
    expect(await settled(jobs, done.id)).toMatchObject({ status: "exited", exitCode: 7, head: "hello native" });
    const stopped = await jobs.start("sleep 30", tmpdir(), owner, 60);
    expect((await jobs.stop(stopped.id, scope)).status).toBe("stopped");
    const timed = await jobs.start("sleep 30", tmpdir(), owner, 1);
    expect((await settled(jobs, timed.id)).status).toBe("timed-out");
  }, 10000);
});

describe("opt-in bash_job tool", () => {
  it("registers nothing by default and skips missing/overridden bash or conflicting job tools", async () => {
    const f = toolFixture();
    await f.registration.sync(false, f.context);
    expect(f.pi.registerTool).not.toHaveBeenCalled();
    for (const sources of [[], [{ name: "bash", sourceInfo: { source: "extension" } }],
      [{ name: "bash", sourceInfo: { source: "builtin" } }, { name: "bash_job", sourceInfo: { source: "extension" } }]]) {
      f.sources(sources);
      await f.registration.sync(true, f.context);
    }
    expect(f.pi.registerTool).not.toHaveBeenCalled();
  });

  it("does not expose or start jobs when native bash is deactivated", async () => {
    const f = toolFixture();
    f.pi.setActiveTools(["read"]);
    await f.registration.sync(true, f.context);
    expect(f.pi.registerTool).not.toHaveBeenCalled();
    f.pi.setActiveTools(["bash"]);
    await f.registration.sync(true, f.context);
    f.pi.setActiveTools(["bash_job"]);
    await expect(f.run({ action: "start", command: "sleep" })).rejects.toThrow("active built-in");
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("does not re-enable a module after a concurrent disable or shutdown", async () => {
    const f = toolFixture();
    const enabling = f.registration.sync(true, f.context);
    await f.registration.sync(false, f.context);
    await enabling;
    expect(f.pi.registerTool).not.toHaveBeenCalled();
    const reenable = f.registration.sync(true, f.context);
    await f.registration.shutdown();
    await reenable;
    expect(f.pi.registerTool).not.toHaveBeenCalled();
  });

  it("requires trust/confirmation, rejects irrelevant/mutated fields and does not spawn on refusal", async () => {
    const f = toolFixture(); await f.registration.sync(true, f.context);
    for (const args of [{ action: "start", command: "sleep", timeout: NaN }, { action: "list", command: "sleep" }, { action: "stop" }]) {
      await expect(f.run(args)).rejects.toThrow();
    }
    expect(f.confirm).not.toHaveBeenCalled();
    f.context.hasUI = false;
    await expect(f.run({ action: "start", command: "sleep" })).rejects.toThrow("confirmation");
    f.context.hasUI = true; f.context.isProjectTrusted = () => false;
    await expect(f.run({ action: "start", command: "sleep" })).rejects.toThrow("trusted");
    f.context.isProjectTrusted = () => true; f.confirm.mockResolvedValue(false);
    expect(await f.run({ action: "start", command: "sleep" })).toEqual({ outcome: "cancelled" });
    expect(await f.run({ action: "list" })).toEqual([]);
  });

  it("preserves jobs across compaction with a bounded non-triggering canonical snapshot", async () => {
    const f = toolFixture(); await f.registration.sync(true, f.context);
    const job = await f.run({ action: "start", command: "sleep" });
    f.registration.afterCompaction(f.context);
    expect(f.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "ds4-bash-job-snapshot", display: false }), { triggerTurn: false });
    const sent = vi.mocked(f.pi.sendMessage).mock.calls[0]![0];
    expect(sent.content).toContain(job.id);
    expect(sent.content).not.toContain(job.outputPath);
    expect(await f.run({ action: "status", id: job.id })).toMatchObject({ status: "running" });
    await f.registration.sync(false, f.context);
    expect(f.active()).not.toContain("bash_job");
    expect(existsSync(job.outputPath)).toBe(false);
    await expect(f.run({ action: "status", id: job.id })).rejects.toThrow("disabled");
    expect(f.finish).toHaveBeenCalledTimes(1);
  });

  it("does not execute arguments changed during consent and cancels consent on a session change", async () => {
    const executed: string[] = [];
    const f = toolFixture({ exec: async (command) => { executed.push(command); return { exitCode: 0 }; } });
    await f.registration.sync(true, f.context);
    const args = { action: "start", command: "approved" };
    f.confirm.mockImplementation(async () => { args.command = "different"; return true; });
    await f.run(args);
    await vi.waitFor(() => expect(executed).toEqual(["approved"]));
    f.confirm.mockImplementation(async () => { await f.registration.sync(false, f.context); return true; });
    await expect(f.run({ action: "start", command: "do not run" })).rejects.toThrow("context changed");
    expect(executed).toEqual(["approved"]);
  });

  it("does not start a command when cancellation arrives during confirmation", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const f = toolFixture({ exec }); await f.registration.sync(true, f.context);
    const controller = new AbortController();
    f.confirm.mockImplementation(async () => { controller.abort(); return true; });
    await expect(f.run({ action: "start", command: "never" }, controller.signal)).rejects.toThrow("aborted");
    expect(exec).not.toHaveBeenCalled();
    expect(await f.run({ action: "list" })).toEqual([]);
  });

  it("keeps running jobs independent of an aborted status request", async () => {
    const f = toolFixture(); await f.registration.sync(true, f.context);
    const job = await f.run({ action: "start", command: "sleep" });
    const abort = new AbortController(); abort.abort();
    await expect(f.run({ action: "status", id: job.id }, abort.signal)).rejects.toThrow("aborted");
    expect(await f.run({ action: "status", id: job.id })).toMatchObject({ status: "running" });
    await f.run({ action: "stop", id: job.id });
    expect(f.finish).toHaveBeenCalledTimes(1);
  });
});

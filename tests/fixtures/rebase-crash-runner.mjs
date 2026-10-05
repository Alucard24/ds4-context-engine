// Offline subprocess fixture: exits while holding the kernel lock, without catch/finally recovery.
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ContextDatabase } from "ds4-context-core/persistence/sqlite";
import { DEFAULT_CONFIG } from "ds4-context-core/config/config";
const require = createRequire(import.meta.url);
const { createJiti } = require(require.resolve("jiti", { paths: [dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")))] }));
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
globalThis.fetch = () => { throw new Error("provider-network-forbidden"); };
const { PiSessionRebase } = await jiti.import("../../src/pi-adapter/session-rebase.ts");
const [file, phase] = process.argv.slice(2);
if (!file || !phase || !file.includes("ds4-rebase-")) process.exit(92);
const manager = SessionManager.open(file);
const projectPath = manager.getHeader().cwd;
const db = ContextDatabase.open(`${dirname(file)}/crash-projection.db`);
const config = structuredClone(DEFAULT_CONFIG);
config.historyTools.enabled = true; config.sessionRebase.enabled = true;
const ctx = { sessionManager: manager, cwd: projectPath, isProjectTrusted: () => true,
  isIdle: () => true, hasPendingMessages: () => false, waitForIdle: async () => {}, ui: { notify: () => {} },
  switchSession: async (target, options) => {
    ctx.sessionManager = SessionManager.open(target);
    await options.withSession({ sessionManager: ctx.sessionManager, ui: ctx.ui });
    return { cancelled: false };
  },
};
await new PiSessionRebase().run(ctx, { config, database: db, projectPath, compactionActive: () => false,
  snapshotMemory: () => ({ pins: [], memories: [] }), afterPhase: (current) => { if (current === phase) process.exit(91); } });
process.exit(93);

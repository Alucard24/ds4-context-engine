import type { CanonicalMessage } from "../core/canonical-message.ts";
import type { ModelDescriptor } from "../core/model-profile.ts";
import {
  RUNTIME_ADAPTER_CONTRACT_VERSION,
  RUNTIME_CAPABILITY_IDS,
  type RuntimeAdapter,
  type RuntimeCompletionTransport,
  type RuntimeCompletionTransportRequest,
  type RuntimeHistorySnapshot,
  type RuntimeToolAtomicGroup,
  buildCanonicalToolAtomicGroups,
  validateRuntimeHistorySnapshot,
} from "./runtime-adapter.ts";

export const RUNTIME_ADAPTER_CONFORMANCE_VERSION = "runtime-adapter-conformance-v1" as const;

export interface RuntimeAdapterConformanceFixture {
  runtimeId: string;
  sessionId: string;
  messages: CanonicalMessage[];
  model: ModelDescriptor;
}

export interface RuntimeAdapterConformanceInstance {
  adapter: RuntimeAdapter;
  expectedProjectRoot: string;
  cleanup?: () => void | Promise<void>;
}

export interface RuntimeAdapterConformanceFactory {
  name: string;
  create(
    fixture: RuntimeAdapterConformanceFixture,
    transport: RuntimeCompletionTransport,
  ): Promise<RuntimeAdapterConformanceInstance>;
}

export interface RuntimeAdapterConformanceCase {
  id: "identity" | "capabilities" | "canonical-history" | "rebuild" | "privacy" | "fallback" | "lifecycle";
  passed: boolean;
  failureCode?: string;
}

export interface RuntimeAdapterConformanceReport {
  version: typeof RUNTIME_ADAPTER_CONFORMANCE_VERSION;
  contractVersion: typeof RUNTIME_ADAPTER_CONTRACT_VERSION;
  factoryName: string;
  passed: boolean;
  cases: RuntimeAdapterConformanceCase[];
}

const PRIVATE_MARKER_TEXT = "DS4_CONFORMANCE_PRIVATE_VALUE";
const CREDENTIAL_TEXT = "sk-conformance-credential-123456";

function conformanceMessages(sessionId: string): CanonicalMessage[] {
  const provenance = (entryId: string) => ({
    source: "runtime-session" as const,
    runtimeId: "conformance-runtime",
    sessionId,
    entryId,
  });
  return [
    {
      id: `${sessionId}:entry-user`,
      sourceEntryId: "entry-user",
      role: "user",
      blocks: [{ type: "text", text: "Inspect the reference project." }],
      provenance: provenance("entry-user"),
      tokenEstimate: 8,
      flags: {},
    },
    {
      id: `${sessionId}:entry-call`,
      sourceEntryId: "entry-call",
      role: "assistant",
      blocks: [{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "src/index.ts" } }],
      provenance: provenance("entry-call"),
      tokenEstimate: 12,
      flags: { atomic: true },
    },
    {
      id: `${sessionId}:entry-result`,
      sourceEntryId: "entry-result",
      role: "tool",
      blocks: [{
        type: "toolResult",
        toolCallId: "tool-call-1",
        toolName: "read",
        content: "export const ready = true;",
        isError: false,
      }],
      provenance: provenance("entry-result"),
      tokenEstimate: 10,
      flags: { atomic: true },
    },
    {
      id: `${sessionId}:entry-assistant`,
      sourceEntryId: "entry-assistant",
      role: "assistant",
      blocks: [{ type: "text", text: "The project is ready." }],
      provenance: provenance("entry-assistant"),
      tokenEstimate: 7,
      flags: {},
    },
  ];
}

export function createRuntimeAdapterConformanceFixture(): RuntimeAdapterConformanceFixture {
  const sessionId = "runtime-adapter-conformance-session";
  return {
    runtimeId: "conformance-runtime",
    sessionId,
    messages: conformanceMessages(sessionId),
    model: {
      provider: "conformance-remote",
      id: "conformance-model",
      contextWindow: 32_768,
      maxTokens: 4_096,
      reasoning: false,
      input: ["text"],
    },
  };
}

function sameMessageProjection(left: RuntimeHistorySnapshot, right: RuntimeHistorySnapshot): boolean {
  return left.revision === right.revision
    && left.sessionId === right.sessionId
    && left.projectRoot === right.projectRoot
    && left.messages.map((message) => message.id).join("\0")
      === right.messages.map((message) => message.id).join("\0")
    && JSON.stringify(left.toolAtomicGroups) === JSON.stringify(right.toolAtomicGroups);
}

function completeToolGroup(groups: readonly RuntimeToolAtomicGroup[]): boolean {
  return groups.length === 1
    && groups[0]?.complete === true
    && groups[0]?.toolCallIds.join("\0") === "tool-call-1";
}

function payloadContainsPrivateData(value: unknown): boolean {
  let serialized = "";
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return true;
  }
  return serialized.includes(PRIVATE_MARKER_TEXT) || serialized.includes(CREDENTIAL_TEXT);
}

export async function runRuntimeAdapterConformance(
  factory: RuntimeAdapterConformanceFactory,
): Promise<RuntimeAdapterConformanceReport> {
  const fixture = createRuntimeAdapterConformanceFixture();
  const transmitted: RuntimeCompletionTransportRequest[] = [];
  let failNextTransport = false;
  const transport: RuntimeCompletionTransport = async (request) => {
    if (failNextTransport) {
      failNextTransport = false;
      throw new Error("Synthetic conformance transport failure");
    }
    transmitted.push(request);
    return { role: "assistant", content: "conformance completion" };
  };
  const instance = await factory.create(fixture, transport);
  const { adapter } = instance;
  const cases: RuntimeAdapterConformanceCase[] = [];
  const check = async (
    id: RuntimeAdapterConformanceCase["id"],
    assertion: () => boolean | Promise<boolean>,
  ): Promise<void> => {
    try {
      const passed = await assertion();
      cases.push(passed ? { id, passed: true } : { id, passed: false, failureCode: `${id}-assertion-failed` });
    } catch {
      cases.push({ id, passed: false, failureCode: `${id}-threw` });
    }
  };

  try {
    await check("identity", async () => {
      const model = await adapter.currentModel();
      const root = await adapter.trustedProjectRoot();
      return adapter.identity.contractVersion === RUNTIME_ADAPTER_CONTRACT_VERSION
        && adapter.identity.runtimeId === fixture.runtimeId
        && adapter.identity.adapterName.trim().length > 0
        && adapter.identity.adapterVersion.trim().length > 0
        && root === instance.expectedProjectRoot
        && model?.provider === fixture.model.provider
        && model.id === fixture.model.id
        && model.contextWindow === fixture.model.contextWindow;
    });

    await check("capabilities", () => {
      const negotiation = adapter.negotiateCapabilities(
        RUNTIME_CAPABILITY_IDS.map((id) => ({ id })),
      );
      return negotiation.contractVersion === RUNTIME_ADAPTER_CONTRACT_VERSION
        && negotiation.statuses.length === RUNTIME_CAPABILITY_IDS.length
        && negotiation.statuses.every((status) => status.supported
          ? Boolean(status.version)
          : Boolean(status.reason)
            && negotiation.diagnostics.some((diagnostic) => diagnostic.capability === status.id));
    });

    let initialSnapshot: RuntimeHistorySnapshot | undefined;
    await check("canonical-history", async () => {
      initialSnapshot = await adapter.snapshotHistory();
      return initialSnapshot.runtimeId === fixture.runtimeId
        && initialSnapshot.sessionId === fixture.sessionId
        && initialSnapshot.projectRoot === instance.expectedProjectRoot
        && initialSnapshot.messages.map((message) => message.id).join("\0")
          === fixture.messages.map((message) => message.id).join("\0")
        && validateRuntimeHistorySnapshot(initialSnapshot).length === 0
        && completeToolGroup(initialSnapshot.toolAtomicGroups)
        && JSON.stringify(initialSnapshot.toolAtomicGroups)
          === JSON.stringify(buildCanonicalToolAtomicGroups(initialSnapshot.messages));
    });

    await check("rebuild", async () => {
      const baseline = initialSnapshot ?? await adapter.snapshotHistory();
      const rebuilt = await adapter.rebuildDerivedState();
      return validateRuntimeHistorySnapshot(rebuilt).length === 0
        && sameMessageProjection(baseline, rebuilt);
    });

    const privatePayload = {
      messages: [{
        role: "user",
        content: `[ds4:local-only]${PRIVATE_MARKER_TEXT}[/ds4:local-only] public ${CREDENTIAL_TEXT}`,
      }],
    };
    await check("privacy", async () => {
      const sanitized = await adapter.enforcePrivacy({
        provider: fixture.model.provider,
        payload: privatePayload,
      });
      const before = transmitted.length;
      const completion = await adapter.complete({
        provider: fixture.model.provider,
        model: fixture.model.id,
        payload: privatePayload,
      });
      const sent = transmitted.at(-1);
      const hostilePayload: Record<string, unknown> = {};
      Object.defineProperty(hostilePayload, "messages", {
        enumerable: true,
        get() {
          throw new Error("Synthetic privacy traversal failure");
        },
      });
      const beforeFailedClosed = transmitted.length;
      const failedClosed = await adapter.complete({
        provider: fixture.model.provider,
        model: fixture.model.id,
        payload: hostilePayload,
      });
      return sanitized.destination === "remote"
        && sanitized.changed
        && !payloadContainsPrivateData(sanitized.payload)
        && completion.status === "completed"
        && transmitted.length === before + 1
        && sent?.destination === "remote"
        && !payloadContainsPrivateData(sent?.payload)
        && failedClosed.status === "fallback"
        && failedClosed.code === "privacy-enforcement-failed"
        && transmitted.length === beforeFailedClosed;
    });

    await check("fallback", async () => {
      failNextTransport = true;
      const before = transmitted.length;
      const completion = await adapter.complete({
        provider: fixture.model.provider,
        model: fixture.model.id,
        payload: { messages: [{ role: "user", content: "transport fallback probe" }] },
      });
      return completion.status === "fallback"
        && completion.code === "transport-failed"
        && completion.retryable
        && transmitted.length === before
        && adapter.diagnostics().some((diagnostic) => diagnostic.code === "completion-transport-failed");
    });

    await check("lifecycle", async () => {
      await adapter.shutdown();
      await adapter.shutdown();
      const completion = await adapter.complete({
        provider: fixture.model.provider,
        model: fixture.model.id,
        payload: { messages: [] },
      });
      let historyRejected = false;
      try {
        await adapter.snapshotHistory();
      } catch {
        historyRejected = true;
      }
      return completion.status === "fallback"
        && completion.code === "adapter-closed"
        && historyRejected
        && adapter.diagnostics().some((diagnostic) => diagnostic.code === "adapter-closed");
    });
  } finally {
    try {
      await adapter.shutdown();
    } finally {
      await instance.cleanup?.();
    }
  }

  return {
    version: RUNTIME_ADAPTER_CONFORMANCE_VERSION,
    contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    factoryName: factory.name,
    passed: cases.length === 7 && cases.every((item) => item.passed),
    cases,
  };
}

export function assertRuntimeAdapterConformance(report: RuntimeAdapterConformanceReport): void {
  const failed = report.cases.filter((item) => !item.passed).map((item) => item.id);
  if (!report.passed || failed.length > 0) {
    throw new Error(`Runtime adapter conformance failed: ${failed.join(", ") || "incomplete report"}`);
  }
}

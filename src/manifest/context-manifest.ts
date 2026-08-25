import type {
  PrivacyClassification,
  ProviderDestination,
} from "../privacy/privacy-policy.ts";

export type ContextManifestItemKind =
  | "system"
  | "tool"
  | "pin"
  | "recent"
  | "summary"
  | "retrieval"
  | "history"
  | "project"
  | "memory"
  | "current";

export interface ContextManifestItem {
  kind: ContextManifestItemKind;
  sourceId?: string;
  role?: string;
  groupId?: string;
  tokens: number;
  score?: number;
  classification?: PrivacyClassification;
  reason: string;
}

export interface ProjectSnippetRef {
  snippetId?: string;
  path: string;
  hash: string;
  startLine?: number;
  endLine?: number;
  score?: number;
  modified?: boolean;
  gitCommit?: string;
}

export interface PinManifestRef {
  pinId: string;
  scope: "session" | "branch" | "project";
  branchLeafId?: string;
  sourceSessionId?: string;
  sourceEntryId?: string;
  sourceFile?: string;
  classification?: PrivacyClassification;
  estimatedTokens: number;
  reason: string;
}

export interface MemoryManifestRef {
  memoryId: string;
  scope: "session" | "project";
  key?: string;
  classification?: PrivacyClassification;
  originSessionId: string;
  sourceEntryIds: string[];
  estimatedTokens: number;
  score: number;
  reason: string;
}

export interface ArtifactManifestRef {
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  sourceEntryId: string;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  originalTokens: number;
  condensedTokens: number;
  classification?: PrivacyClassification;
}

export interface PrivacyManifest {
  enabled: boolean;
  destination: ProviderDestination;
  provider: string;
  allowedClassifications: PrivacyClassification[];
  selectedClassifications: Record<PrivacyClassification, number>;
  blockedBlocks: number;
  excludedSources: number;
  secretRedactions: number;
  providerChecks: number;
  providerPayloadRedactions: number;
  enforcement: "context" | "context-and-provider";
}

export interface ProjectRevision {
  projectPath: string;
  gitRoot?: string;
  branch?: string;
  head?: string;
  dirty: boolean;
  changedFiles: string[];
  indexedAt: number;
}

export interface ContextManifestComposition {
  systemTokens: number;
  toolTokens: number;
  messageTokens: number;
  messageCount: number;
  toolCount: number;
}

export interface ContextManifestPlanning {
  mode: "observer" | "managed" | "fallback";
  originalMessageTokens: number;
  originalMessageCount: number;
  fixedTokens: number;
  messageTargetTokens: number;
  messageHardLimitTokens: number;
  recentTailTokenLimit: number;
  selectedGroupCount: number;
  excludedGroupCount: number;
  durationMs?: number;
  fallbackReason?: string;
}

export interface ContextManifest {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  branchLeafId?: string;
  provider: string;
  model: string;
  contextWindow: number;
  outputReserve: number;
  hardInputLimit: number;
  targetInputTokens: number;
  estimatedInputTokens: number;
  actualInputTokens?: number;
  piReportedContextTokens?: number;
  included: ContextManifestItem[];
  excluded: ContextManifestItem[];
  summaryIds: string[];
  retrievedEventIds: string[];
  projectSnippets: ProjectSnippetRef[];
  projectRevision?: ProjectRevision;
  pins?: PinManifestRef[];
  memories?: MemoryManifestRef[];
  artifacts?: ArtifactManifestRef[];
  privacy?: PrivacyManifest;
  composition: ContextManifestComposition;
  planning?: ContextManifestPlanning;
  policyVersion: string;
  plannerVersion: string;
  promptHash: string;
  createdAt: number;
}

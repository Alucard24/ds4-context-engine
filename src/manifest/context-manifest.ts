export type ContextManifestItemKind =
  | "system"
  | "tool"
  | "pin"
  | "recent"
  | "summary"
  | "history"
  | "project"
  | "memory"
  | "current";

export interface ContextManifestItem {
  kind: ContextManifestItemKind;
  sourceId?: string;
  role?: string;
  tokens: number;
  score?: number;
  reason: string;
}

export interface ProjectSnippetRef {
  path: string;
  hash: string;
  startLine?: number;
  endLine?: number;
}

export interface ContextManifestComposition {
  systemTokens: number;
  toolTokens: number;
  messageTokens: number;
  messageCount: number;
  toolCount: number;
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
  composition: ContextManifestComposition;
  policyVersion: string;
  plannerVersion: string;
  promptHash: string;
  createdAt: number;
}

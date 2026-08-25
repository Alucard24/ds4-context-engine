export type CanonicalRole = "system" | "user" | "assistant" | "tool" | "custom";

export interface Provenance {
  source: "pi-session";
  sessionId: string;
  entryId: string;
  originalRole?: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResultBlock {
  type: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

export interface ImageBlock {
  type: "image";
  mimeType?: string;
  data?: string;
}

export interface FileReferenceBlock {
  type: "fileReference";
  path: string;
}

export interface ArtifactReferenceBlock {
  type: "artifactReference";
  artifactId: string;
}

export interface SummaryReferenceBlock {
  type: "summaryReference";
  summaryId: string;
}

export interface OpaqueProviderBlock {
  type: "opaqueProvider";
  originalType?: string;
  value: unknown;
}

export type CanonicalBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | ImageBlock
  | FileReferenceBlock
  | ArtifactReferenceBlock
  | SummaryReferenceBlock
  | OpaqueProviderBlock;

export interface CanonicalMessage {
  id: string;
  sourceEntryId: string;
  role: CanonicalRole;
  blocks: CanonicalBlock[];
  createdAt?: number;
  provider?: string;
  model?: string;
  provenance: Provenance;
  tokenEstimate?: number;
  flags: {
    pinned?: boolean;
    atomic?: boolean;
    localOnly?: boolean;
    synthetic?: boolean;
  };
}

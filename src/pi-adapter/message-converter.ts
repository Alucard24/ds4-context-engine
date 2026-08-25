import type {
  CanonicalBlock,
  CanonicalMessage,
  CanonicalRole,
  ImageBlock,
} from "ds4-context-core/core/canonical-message";
import { estimateMessageTokens } from "ds4-context-core/core/token-estimator";

export interface MessageConversionInput {
  sessionId: string;
  entryId: string;
  entryTimestamp?: string;
  message: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function imageBlock(block: Record<string, unknown>): ImageBlock {
  const source = isRecord(block.source) ? block.source : undefined;
  return {
    type: "image",
    ...(stringValue(block.mimeType) || stringValue(source?.mediaType)
      ? { mimeType: stringValue(block.mimeType) ?? stringValue(source?.mediaType) }
      : {}),
    ...(stringValue(block.data) || stringValue(source?.data)
      ? { data: stringValue(block.data) ?? stringValue(source?.data) }
      : {}),
  };
}

function convertContentBlock(block: unknown): CanonicalBlock {
  if (!isRecord(block)) return { type: "opaqueProvider", value: block };

  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return { type: "thinking", thinking: block.thinking };
  }
  if (block.type === "toolCall") {
    return {
      type: "toolCall",
      id: stringValue(block.id) ?? "",
      name: stringValue(block.name) ?? "",
      arguments: block.arguments,
    };
  }
  if (block.type === "image") return imageBlock(block);

  return {
    type: "opaqueProvider",
    ...(typeof block.type === "string" ? { originalType: block.type } : {}),
    value: block,
  };
}

function contentBlocks(content: unknown): CanonicalBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return content == null ? [] : [{ type: "opaqueProvider", value: content }];
  return content.map(convertContentBlock);
}

function canonicalRole(originalRole: string | undefined): CanonicalRole {
  switch (originalRole) {
    case "system":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
    case "bashExecution":
      return "tool";
    default:
      return "custom";
  }
}

function timestamp(message: Record<string, unknown>, entryTimestamp: string | undefined): number | undefined {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  if (!entryTimestamp) return undefined;
  const parsed = Date.parse(entryTimestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function toCanonicalMessage(input: MessageConversionInput): CanonicalMessage {
  const message = isRecord(input.message) ? input.message : {};
  const originalRole = stringValue(message.role);
  let blocks = contentBlocks(message.content);

  if (originalRole === "toolResult") {
    const text = blocks
      .filter((block): block is Extract<CanonicalBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const images = blocks.filter((block): block is ImageBlock => block.type === "image");
    blocks = [
      {
        type: "toolResult",
        toolCallId: stringValue(message.toolCallId) ?? "",
        toolName: stringValue(message.toolName) ?? "",
        content: text,
        isError: message.isError === true,
      },
      ...images,
    ];
  } else if (originalRole === "bashExecution") {
    blocks = [
      { type: "text", text: `Command: ${stringValue(message.command) ?? ""}` },
      { type: "text", text: stringValue(message.output) ?? "" },
    ];
  }

  const createdAt = timestamp(message, input.entryTimestamp);
  return {
    id: `${input.sessionId}:${input.entryId}`,
    sourceEntryId: input.entryId,
    role: canonicalRole(originalRole),
    blocks,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(stringValue(message.provider) ? { provider: stringValue(message.provider) } : {}),
    ...(stringValue(message.model) ? { model: stringValue(message.model) } : {}),
    provenance: {
      source: "pi-session",
      sessionId: input.sessionId,
      entryId: input.entryId,
      ...(originalRole ? { originalRole } : {}),
    },
    tokenEstimate: estimateMessageTokens(message),
    flags: {
      atomic: originalRole === "toolResult" || blocks.some((block) => block.type === "toolCall"),
    },
  };
}

export function canonicalMessageSearchText(message: CanonicalMessage): string {
  const parts: string[] = [];
  for (const block of message.blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "toolCall":
        parts.push(block.name, safeJson(block.arguments));
        break;
      case "toolResult":
        parts.push(block.toolName, block.content);
        break;
      case "fileReference":
        parts.push(block.path);
        break;
      case "artifactReference":
        parts.push(block.artifactId);
        break;
      case "summaryReference":
        parts.push(block.summaryId);
        break;
      // Thinking, image data, and opaque provider payloads are preserved but
      // intentionally excluded from the lexical index.
      case "thinking":
      case "image":
      case "opaqueProvider":
        break;
    }
  }
  return parts.filter(Boolean).join("\n");
}

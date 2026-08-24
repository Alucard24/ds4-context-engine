const CHARS_PER_TOKEN = 4;
const MESSAGE_WRAPPER_TOKENS = 8;
const CONTENT_BLOCK_WRAPPER_TOKENS = 4;
const IMAGE_TOKEN_ESTIMATE = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

export function estimateTextTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateContent(content: unknown): number {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return estimateTextTokens(safeJson(content));

  return content.reduce((tokens, block) => {
    if (!isRecord(block)) return tokens + estimateTextTokens(safeJson(block));

    const type = block.type;
    if (type === "image") return tokens + IMAGE_TOKEN_ESTIMATE + CONTENT_BLOCK_WRAPPER_TOKENS;
    if (type === "text" && typeof block.text === "string") {
      return tokens + estimateTextTokens(block.text) + CONTENT_BLOCK_WRAPPER_TOKENS;
    }
    if (type === "thinking" && typeof block.thinking === "string") {
      return tokens + estimateTextTokens(block.thinking) + CONTENT_BLOCK_WRAPPER_TOKENS;
    }
    if (type === "toolCall") {
      const name = typeof block.name === "string" ? block.name : "";
      return tokens + estimateTextTokens(name + safeJson(block.arguments)) + CONTENT_BLOCK_WRAPPER_TOKENS;
    }

    return tokens + estimateTextTokens(safeJson(block)) + CONTENT_BLOCK_WRAPPER_TOKENS;
  }, 0);
}

export function estimateMessageTokens(message: unknown): number {
  if (!isRecord(message)) return estimateTextTokens(safeJson(message)) + MESSAGE_WRAPPER_TOKENS;

  let tokens = MESSAGE_WRAPPER_TOKENS;
  if (typeof message.role === "string") tokens += estimateTextTokens(message.role);

  if ("content" in message) tokens += estimateContent(message.content);
  if (typeof message.summary === "string") tokens += estimateTextTokens(message.summary);
  if (typeof message.command === "string") tokens += estimateTextTokens(message.command);
  if (typeof message.output === "string") tokens += estimateTextTokens(message.output);
  if (typeof message.toolName === "string") tokens += estimateTextTokens(message.toolName);

  return tokens;
}

export function estimateMessagesTokens(messages: readonly unknown[]): number {
  return messages.reduce<number>((total, message) => total + estimateMessageTokens(message), 0);
}

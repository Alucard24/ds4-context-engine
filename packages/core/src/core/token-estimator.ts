const CHARS_PER_TOKEN = 4;
const MESSAGE_WRAPPER_TOKENS = 8;
const CONTENT_BLOCK_WRAPPER_TOKENS = 4;
const IMAGE_TOKEN_ESTIMATE = 1024;

/** Counts text only; message/block and image overhead remains a heuristic. */
export interface TokenEstimator {
  readonly version: string;
  estimateTextTokens(text: string): number;
  estimateMessageTokens(message: unknown): number;
  estimateMessagesTokens(messages: readonly unknown[]): number;
}

export function createTokenEstimator(version: string, countText: (text: string) => number): TokenEstimator {
  const text = (value: string): number => value.length === 0 ? 0 : countText(value);
  const message = (value: unknown): number => estimateMessage(value, text);
  return {
    version,
    estimateTextTokens: text,
    estimateMessageTokens: message,
    estimateMessagesTokens: (messages) => messages.reduce<number>((total, value) => total + message(value), 0),
  };
}

export const CHARS_ESTIMATOR: TokenEstimator = createTokenEstimator(
  "chars-v1", (text) => Math.ceil(text.length / CHARS_PER_TOKEN),
);

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
  return CHARS_ESTIMATOR.estimateTextTokens(text);
}

function estimateContent(content: unknown, countText: (text: string) => number): number {
  if (typeof content === "string") return countText(content);
  if (!Array.isArray(content)) return countText(safeJson(content));

  return content.reduce<number>((tokens, block) => {
    if (!isRecord(block)) return tokens + countText(safeJson(block));

    const type = block.type;
    if (type === "image") return tokens + IMAGE_TOKEN_ESTIMATE + CONTENT_BLOCK_WRAPPER_TOKENS;
    if (type === "text" && typeof block.text === "string") {
      return tokens + countText(block.text) + CONTENT_BLOCK_WRAPPER_TOKENS;
    }
    if (type === "thinking" && typeof block.thinking === "string") {
      return tokens + countText(block.thinking) + CONTENT_BLOCK_WRAPPER_TOKENS;
    }
    if (type === "toolCall") {
      const name = typeof block.name === "string" ? block.name : "";
      return tokens + countText(name + safeJson(block.arguments)) + CONTENT_BLOCK_WRAPPER_TOKENS;
    }

    return tokens + countText(safeJson(block)) + CONTENT_BLOCK_WRAPPER_TOKENS;
  }, 0);
}

function estimateMessage(message: unknown, countText: (text: string) => number): number {
  if (!isRecord(message)) return countText(safeJson(message)) + MESSAGE_WRAPPER_TOKENS;

  let tokens = MESSAGE_WRAPPER_TOKENS;
  if (typeof message.role === "string") tokens += countText(message.role);

  if ("content" in message) tokens += estimateContent(message.content, countText);
  if (typeof message.summary === "string") tokens += countText(message.summary);
  if (typeof message.command === "string") tokens += countText(message.command);
  if (typeof message.output === "string") tokens += countText(message.output);
  if (typeof message.toolName === "string") tokens += countText(message.toolName);

  return tokens;
}

export function estimateMessageTokens(message: unknown): number {
  return CHARS_ESTIMATOR.estimateMessageTokens(message);
}

export function estimateMessagesTokens(messages: readonly unknown[]): number {
  return CHARS_ESTIMATOR.estimateMessagesTokens(messages);
}

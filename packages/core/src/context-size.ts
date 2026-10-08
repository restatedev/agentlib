// Estimating how many tokens messages take, for models that have not reported
// usage yet and for messages added since their last report. A tokenizer would
// be exact but model-specific; characters are cheap, deterministic on replay,
// and err on the large side: about four ASCII characters per token for prose,
// two for JSON. Other scripts, such as CJK, and emoji take about a token per
// UTF-16 unit, so each counts as one.
import type {Message} from "./types.js";

const TEXT_CHARS_PER_TOKEN = 4;
const JSON_CHARS_PER_TOKEN = 2;
// Role and separators each message adds to a request.
const MESSAGE_OVERHEAD = 4;

export function estimateTokens(messages: readonly Message[]): number {
  let tokens = 0;
  for (const message of messages) tokens += MESSAGE_OVERHEAD + messageTokens(message);
  return tokens;
}

function messageTokens(message: Message): number {
  if (message.role === "tool") return jsonTokens(JSON.stringify(message.result));
  // Runtime notes, such as background results, are JSON in a user message.
  const text = message.content.startsWith("{")
    ? jsonTokens(message.content)
    : textTokens(message.content);
  if (message.role === "user" || !message.calls) return text;
  return text + jsonTokens(JSON.stringify(message.calls));
}

export function textTokens(text: string): number {
  return charTokens(text, TEXT_CHARS_PER_TOKEN);
}

export function jsonTokens(json: string): number {
  return charTokens(json, JSON_CHARS_PER_TOKEN);
}

function charTokens(text: string, asciiPerToken: number): number {
  let other = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) other++;
  return Math.ceil((text.length - other) / asciiPerToken) + other;
}

/** Characters of JSON that fit in `tokens` by the same estimate. */
export function jsonChars(tokens: number): number {
  return tokens * JSON_CHARS_PER_TOKEN;
}

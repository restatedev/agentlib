// Estimating how many tokens messages take, for models that have not reported
// usage yet and for messages added since their last report. A tokenizer would
// be exact but model-specific; characters are cheap, deterministic on replay,
// and err on the large side: about four per token for prose, two for JSON.
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
    : Math.ceil(message.content.length / TEXT_CHARS_PER_TOKEN);
  if (message.role === "user" || !message.calls) return text;
  return text + jsonTokens(JSON.stringify(message.calls));
}

export function jsonTokens(json: string): number {
  return Math.ceil(json.length / JSON_CHARS_PER_TOKEN);
}

/** Characters of JSON that fit in `tokens` by the same estimate. */
export function jsonChars(tokens: number): number {
  return tokens * JSON_CHARS_PER_TOKEN;
}

/** Validate configuration before it reaches a scheduler, timer, or guest VM. */
export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

/** The tokens the context-window check leaves for a reply when `maxOutputTokens`
 * is unset and the model's provider picks the limit. */
export const REPLY_RESERVE = 32768;

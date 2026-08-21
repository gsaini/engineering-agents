import { createHash, randomUUID } from 'node:crypto';

export function newRunId(): string {
  return `run_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export function sha256(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update(' ');
  return h.digest('hex');
}

/**
 * Idempotency key for a work item trigger. Includes the revision, so an edited
 * ticket produces a new run while a re-poll of the same revision does not.
 */
export function workItemIdempotencyKey(sourceId: string, itemId: string, rev: string): string {
  return sha256('work-item', sourceId, itemId, rev).slice(0, 32);
}

/**
 * Idempotency key for a log signal. Bucketed by detection window, so the same
 * cluster inside one window collapses to a single run.
 */
export function logSignalIdempotencyKey(
  sourceId: string,
  fingerprint: string,
  windowStart: string,
): string {
  return sha256('log-signal', sourceId, fingerprint, windowStart).slice(0, 32);
}

const PLACEHOLDERS: [RegExp, string][] = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>'],
  [/(?:\/[\w.-]+){2,}/g, '<path>'],
  [/https?:\/\/\S+/g, '<url>'],
  [/0x[0-9a-f]+/gi, '<hex>'],
  [/\d{3,}/g, '<num>'],
];

/** Strip the varying parts of a log message so equal problems hash equal. */
export function normaliseMessage(message: string): string {
  let out = message;
  for (const [pattern, replacement] of PLACEHOLDERS) out = out.replace(pattern, replacement);
  return out.trim().slice(0, 500);
}

/**
 * Fingerprint a log signal. The stack-frame component is what separates the
 * same exception type thrown from two different code paths.
 */
export function fingerprintSignal(input: {
  exceptionType: string | null;
  message: string;
  frames: string[];
}): string {
  return sha256(
    input.exceptionType ?? 'unknown',
    normaliseMessage(input.message),
    input.frames.slice(0, 5).join('|'),
  ).slice(0, 32);
}

/** Branch-safe slug from a title. */
export function slugify(text: string, maxLength = 40): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength)
      .replace(/-+$/g, '') || 'change'
  );
}

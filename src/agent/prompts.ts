import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = resolve(HERE, '..', '..', 'prompts');

export interface PromptFile {
  id: string;
  version: number;
  body: string;
  meta: Record<string, string>;
}

const cache = new Map<string, PromptFile>();

/** Split the YAML-ish front matter from the prompt body. */
export function parsePrompt(raw: string): PromptFile {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) return { id: 'unknown', version: 0, body: raw.trim(), meta: {} };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return {
    id: meta['id'] ?? 'unknown',
    version: Number(meta['version'] ?? 0),
    body: (match[2] ?? '').trim(),
    meta,
  };
}

export async function loadPrompt(name: string): Promise<PromptFile> {
  const cached = cache.get(name);
  if (cached) return cached;
  const raw = await readFile(join(PROMPT_DIR, `${name}.md`), 'utf8');
  const parsed = parsePrompt(raw);
  cache.set(name, parsed);
  return parsed;
}

/**
 * Wrap content that originated outside the team.
 *
 * Ticket text, comments, and log messages are attacker-controllable. They are
 * never concatenated into instructions — they are labelled as data, and the
 * system prompt states that data inside these tags is never followed.
 *
 * The tag itself is not a security boundary (capability limits are); it is what
 * makes the boundary legible to the model. See docs/05-guardrails.md.
 */
export function untrusted(source: string, kind: string, content: string): string {
  // Strip any attempt to close the wrapper early.
  const safe = content.replace(/<\/?untrusted-data[^>]*>/gi, '');
  return `<untrusted-data source="${escapeAttr(source)}" kind="${escapeAttr(kind)}">\n${safe}\n</untrusted-data>`;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/[<>]/g, '');
}

/** Fill `{{placeholder}}` tokens. A missing value becomes an explicit marker. */
export function render(template: string, values: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) return match;
    if (value === null || value === '') return '(none)';
    return String(value);
  });
}

/** The shared operating rules, prepended to every stage's system prompt. */
export async function systemPrompt(stageRules = ''): Promise<{ text: string; version: number }> {
  const base = await loadPrompt('_system');
  return {
    text: stageRules ? `${base.body}\n\n---\n\n${stageRules}` : base.body,
    version: base.version,
  };
}

/**
 * Cheap heuristic pass for instruction-shaped content in untrusted text.
 *
 * A hit does not block: it flags the run and routes it to `comment` mode with a
 * notification. Blocking silently on a false positive is worse than a human
 * glance.
 */
const INJECTION_MARKERS: RegExp[] = [
  /ignore (?:all )?(?:your |the )?(?:previous|prior|above) instructions/i,
  /disregard (?:your |the )?(?:system )?prompt/i,
  /you are now (?:a|an|in) /i,
  /reveal (?:your |the )(?:system )?(?:prompt|instructions|configuration)/i,
  /(?:send|post|upload|exfiltrate) (?:the |this )?(?:code|repo|secrets?|tokens?) to /i,
  /run the following (?:command|script|shell)/i,
  /\bcurl\s+https?:\/\//i,
];

export function detectInjection(text: string): { suspected: boolean; markers: string[] } {
  const markers = INJECTION_MARKERS.filter((r) => r.test(text)).map((r) => r.source);
  return { suspected: markers.length > 0, markers };
}

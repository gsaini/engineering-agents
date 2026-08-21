/**
 * Redaction at the connector boundary.
 *
 * Secrets and PII are stripped on the way *in* — before anything is written to
 * the run store and before any prompt is assembled. Redacting later would still
 * leave the values in the audit trail, which is the place they are hardest to
 * find and remove.
 *
 * PII uses stable placeholders (`<email:a1>`), so the agent can still reason
 * about "the same user appears in every sample" without ever seeing who.
 */

import { createHash } from 'node:crypto';

export interface RedactionOptions {
  piiCategories: string[];
  extraPatterns: string[];
}

const DEFAULT_OPTIONS: RedactionOptions = {
  piiCategories: ['email', 'phone', 'creditcard'],
  extraPatterns: [],
};

/** Credentials. Always removed outright — never placeholdered, never reversible. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<private-key:redacted>'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt:redacted>'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '<aws-key:redacted>'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<github-token:redacted>'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '<slack-token:redacted>'],
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, '<bearer:redacted>'],
  [/(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[=:]\s*\S+/gi, '<credential:redacted>'],
  [/\b(?:Server|Data Source)=[^;]+;[^"'\s]*(?:Password|Pwd)=[^;"'\s]+/gi, '<connection-string:redacted>'],
];

const PII_PATTERNS: Record<string, RegExp> = {
  email: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g,
  phone: /(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3,4}[ -]?\d{3,4}[ -]?\d{0,4}/g,
  nationalid: /\b\d{3}-\d{2}-\d{4}\b/g,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
};

/** Stable short handle so repeated values stay correlatable after redaction. */
function handle(prefix: string, value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 4);
  return `<${prefix}:${digest}>`;
}

function luhnValid(digits: string): boolean {
  const clean = digits.replace(/\D/g, '');
  if (clean.length < 13 || clean.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    let digit = clean.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redact(text: string, options: Partial<RedactionOptions> = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let out = text;

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }

  for (const category of opts.piiCategories) {
    if (category === 'creditcard') {
      // Luhn-check before redacting: order ids and timestamps are also long
      // digit strings, and redacting them destroys the evidence.
      out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (match) =>
        luhnValid(match) ? handle('card', match.replace(/\D/g, '')) : match,
      );
      continue;
    }
    const pattern = PII_PATTERNS[category];
    if (!pattern) continue;
    out = out.replace(pattern, (match) => handle(category, match));
  }

  for (const raw of opts.extraPatterns) {
    try {
      out = out.replace(new RegExp(raw, 'g'), '<redacted>');
    } catch {
      // An invalid operator-supplied pattern must not take the pipeline down.
    }
  }

  return out;
}

/** Scan a diff before pushing. A committed key costs more than the agent ever saves. */
export function containsSecret(text: string): { found: boolean; kinds: string[] } {
  const kinds: string[] = [];
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (new RegExp(pattern.source, pattern.flags).test(text)) kinds.push(label);
  }
  return { found: kinds.length > 0, kinds };
}

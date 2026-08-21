/**
 * Minimal HTML → Markdown conversion.
 *
 * Trackers store rich text as HTML (Azure DevOps) and it frequently arrives
 * with pasted Word markup. Converting is not cosmetic: raw HTML in a prompt is
 * mostly wasted tokens, and the structure that matters — lists, code, headings —
 * is what carries the requirement.
 *
 * Deliberately dependency-free and lossy. Anything it cannot represent becomes
 * plain text rather than being dropped.
 */

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  let out = html;

  // Drop anything whose text content is not content.
  out = out.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');

  out = out
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<h1[^>]*>/gi, '# ')
    .replace(/<h2[^>]*>/gi, '## ')
    .replace(/<h3[^>]*>/gi, '### ')
    .replace(/<h[456][^>]*>/gi, '#### ')
    .replace(/<(strong|b)>/gi, '**')
    .replace(/<\/(strong|b)>/gi, '**')
    .replace(/<(em|i)>/gi, '_')
    .replace(/<\/(em|i)>/gi, '_')
    .replace(/<code[^>]*>/gi, '`')
    .replace(/<\/code>/gi, '`')
    .replace(/<pre[^>]*>/gi, '\n```\n')
    .replace(/<\/pre>/gi, '\n```\n')
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<td[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');

  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.replaceAll(entity, char);
  }
  out = out.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));

  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Atlassian Document Format → Markdown.
 *
 * ADF is a JSON tree, not text. Naive extraction loses tables and code blocks,
 * which is exactly where requirements tend to hide.
 */
export function adfToMarkdown(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToMarkdown).join('');

  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> };
  const inner = (): string => (n.content ? n.content.map(adfToMarkdown).join('') : '');

  switch (n.type) {
    case 'doc':
      return inner();
    case 'text':
      return n.text ?? '';
    case 'paragraph':
      return `${inner()}\n\n`;
    case 'heading': {
      const level = typeof n.attrs?.['level'] === 'number' ? n.attrs['level'] : 1;
      return `${'#'.repeat(level)} ${inner()}\n\n`;
    }
    case 'bulletList':
    case 'orderedList':
      return `${inner()}\n`;
    case 'listItem':
      return `- ${inner().trim()}\n`;
    case 'codeBlock':
      return `\n\`\`\`${String(n.attrs?.['language'] ?? '')}\n${inner()}\n\`\`\`\n\n`;
    case 'hardBreak':
      return '\n';
    case 'rule':
      return '\n---\n\n';
    case 'table':
      return `${inner()}\n`;
    case 'tableRow':
      return `|${inner()}\n`;
    case 'tableCell':
    case 'tableHeader':
      return ` ${inner().trim()} |`;
    default:
      return inner();
  }
}

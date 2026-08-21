import { describe, expect, it } from 'vitest';

import { configSchema } from '../src/config/schema.js';
import { interpolateEnv, validateReferences, ConfigError } from '../src/config/load.js';
import { adfToMarkdown, htmlToMarkdown } from '../src/connectors/html.js';
import { buildWiql, mapAdoWorkItem } from '../src/connectors/work-items/azure-devops.js';
import { toJqlDate } from '../src/connectors/work-items/jira.js';
import { parseParsedStack, tableToRecords } from '../src/connectors/logs/app-insights.js';
import { resultsToRecords } from '../src/connectors/logs/cloudwatch.js';
import { extractAppFrames, renderQuery } from '../src/connectors/logs/types.js';
import { fingerprintSignal, normaliseMessage, slugify, workItemIdempotencyKey } from '../src/core/ids.js';

describe('config loading', () => {
  it('interpolates environment references', () => {
    expect(interpolateEnv('token: ${MY_TOKEN}', { MY_TOKEN: 'abc' })).toBe('token: abc');
  });

  it('fails on a missing variable rather than silently producing an empty token', () => {
    expect(() => interpolateEnv('token: ${ABSENT}', {})).toThrow(ConfigError);
  });

  it('rejects an agent referencing a source that does not exist', () => {
    const config = configSchema.parse({
      agents: {
        ticketToMr: { enabled: true, sources: ['nope'], codeHost: 'ch', notifier: 'n' },
      },
      codeHosts: [{ id: 'ch', provider: 'github' }],
      notifiers: [{ id: 'n', provider: 'console' }],
    });
    expect(() => validateReferences(config)).toThrow(/unknown workItemSource "nope"/);
  });
});

describe('rich text conversion', () => {
  it('converts Azure DevOps HTML descriptions', () => {
    const html = '<div><b>Retry</b> creates duplicates.</div><ul><li>Step one</li><li>Step two</li></ul>';
    const out = htmlToMarkdown(html);
    expect(out).toContain('**Retry**');
    expect(out).toContain('- Step one');
    expect(out).not.toContain('<');
  });

  it('decodes entities and drops script content', () => {
    expect(htmlToMarkdown('<p>a &amp; b</p><script>alert(1)</script>')).toBe('a & b');
  });

  it('converts Jira ADF, preserving code blocks', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Repro:' }] },
        { type: 'codeBlock', attrs: { language: 'bash' }, content: [{ type: 'text', text: 'curl /refunds' }] },
      ],
    };
    const out = adfToMarkdown(adf);
    expect(out).toContain('Repro:');
    expect(out).toContain('```bash');
    expect(out).toContain('curl /refunds');
  });
});

describe('Azure DevOps mapping', () => {
  const raw = {
    id: 4412,
    rev: 3,
    fields: {
      'System.WorkItemType': 'Bug',
      'System.Title': 'Refund retries duplicate',
      'System.Description': '<p>Retrying a refund creates a second refund.</p>',
      'Microsoft.VSTS.TCM.ReproSteps': '<p>POST /refunds twice</p>',
      'System.State': 'Active',
      'System.Tags': 'agent-ready; payments',
      'System.AreaPath': 'Payments\\Core',
      'System.TeamProject': 'Payments',
      'System.ChangedDate': '2026-08-14T10:05:00Z',
      'System.AssignedTo': { displayName: 'Priya' },
      'Microsoft.VSTS.Common.Priority': 2,
    },
    relations: [
      { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://ado/wit/4400' },
      { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/1', attributes: { name: 'Pull Request' } },
      { rel: 'AttachedFile', url: 'https://ado/attachments/1' },
    ],
  };

  it('normalises fields, tags, and type', () => {
    const item = mapAdoWorkItem(raw, 'ado-main', 'https://dev.azure.com/contoso/Payments');
    expect(item.type).toBe('bug');
    expect(item.labels).toEqual(['agent-ready', 'payments']);
    expect(item.description).toBe('Retrying a refund creates a second refund.');
    expect(item.reproSteps).toBe('POST /refunds twice');
    expect(item.assignee).toBe('Priya');
    expect(item.rev).toBe('3');
  });

  it('keeps only link types that mean something, including existing PRs for dedupe', () => {
    const item = mapAdoWorkItem(raw, 'ado-main', 'https://dev.azure.com/contoso/Payments');
    expect(item.links.map((l) => l.type).sort()).toEqual(['merge-request', 'parent']);
    expect(item.parent?.key).toBe('4400');
  });

  it('builds WIQL that will not drop items sharing the cursor timestamp', () => {
    const options = {
      organization: 'contoso',
      project: 'Payments',
      token: 't',
      baseUrl: 'https://dev.azure.com',
      apiVersion: '7.1',
      workItemTypes: ['Bug', 'Task'],
    };
    const wiql = buildWiql(options, '2026-08-14T10:00:00Z');
    // `>=` rather than `>`: ChangedDate has second granularity.
    expect(wiql).toContain(">= '2026-08-14T10:00:00Z'");
    expect(wiql).toContain("IN ('Bug', 'Task')");
    expect(wiql).toContain('ORDER BY [System.ChangedDate] ASC');
  });
});

describe('Jira helpers', () => {
  it('formats JQL dates in the format JQL actually accepts', () => {
    expect(toJqlDate(new Date('2026-08-14T10:05:00Z'))).toBe('2026/08/14 10:05');
  });
});

describe('log platform shapes', () => {
  it('turns App Insights column/row tables into records', () => {
    const records = tableToRecords({
      name: 'PrimaryResult',
      columns: [{ name: 'problemId', type: 'string' }, { name: 'count_', type: 'long' }],
      rows: [['NullReferenceException', 47]],
    });
    expect(records[0]).toEqual({ problemId: 'NullReferenceException', count_: 47 });
  });

  it('reads the structured parsed stack rather than regexing text', () => {
    const frames = parseParsedStack([
      { parsedStack: [{ method: 'RefundService.ProcessAsync', fileName: 'RefundService.cs', line: 142 }] },
    ]);
    expect(frames[0]).toBe('at RefundService.ProcessAsync (RefundService.cs:142)');
  });

  it('turns CloudWatch field/value rows into records', () => {
    const records = resultsToRecords([[{ field: 'errorType', value: 'TimeoutError' }, { field: 'c', value: '31' }]]);
    expect(records[0]).toEqual({ errorType: 'TimeoutError', c: '31' });
  });

  it('substitutes only known placeholders in a detection query', () => {
    const out = renderQuery('ago({{windowMinutes}}m) > {{minOccurrences}} {{unknown}}', {
      windowMinutes: 15,
      minOccurrences: 25,
    });
    expect(out).toBe('ago(15m) > 25 {{unknown}}');
  });

  it('keeps application frames and drops framework noise', () => {
    const stack = [
      '   at System.Collections.Generic.Dictionary.TryGetValue()',
      '   at Contoso.Payments.RefundService.ProcessAsync()',
    ].join('\n');
    expect(extractAppFrames(stack, ['Contoso.'])).toEqual(['at Contoso.Payments.RefundService.ProcessAsync()']);
  });
});

describe('fingerprinting', () => {
  it('normalises the varying parts of a message', () => {
    const a = normaliseMessage('Order 12345 failed for f47ac10b-58cc-4372-a567-0e02b2c3d479');
    const b = normaliseMessage('Order 98765 failed for 550e8400-e29b-41d4-a716-446655440000');
    expect(a).toBe(b);
  });

  it('separates the same exception thrown from different code paths', () => {
    const base = { exceptionType: 'NullReferenceException', message: 'Object reference not set' };
    const one = fingerprintSignal({ ...base, frames: ['at RefundService.ProcessAsync'] });
    const two = fingerprintSignal({ ...base, frames: ['at ImportService.Parse'] });
    expect(one).not.toBe(two);
  });

  it('collapses the same problem logged with varying ids', () => {
    const one = fingerprintSignal({
      exceptionType: 'NullReferenceException',
      message: 'Refund 12345 has no metadata',
      frames: ['at RefundService.ProcessAsync'],
    });
    const two = fingerprintSignal({
      exceptionType: 'NullReferenceException',
      message: 'Refund 98765 has no metadata',
      frames: ['at RefundService.ProcessAsync'],
    });
    expect(one).toBe(two);
  });

  it('re-triggers a work item on a new revision but not on a re-poll', () => {
    const rev3 = workItemIdempotencyKey('ado', '4412', '3');
    expect(workItemIdempotencyKey('ado', '4412', '3')).toBe(rev3);
    expect(workItemIdempotencyKey('ado', '4412', '4')).not.toBe(rev3);
  });

  it('produces branch-safe slugs', () => {
    expect(slugify('Add idempotency keys to /refunds!')).toBe('add-idempotency-keys-to-refunds');
  });
});

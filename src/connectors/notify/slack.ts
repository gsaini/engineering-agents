import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import type { HealthStatus } from '../../core/types.js';
import { renderApproval, type ApprovalRequest, type Notifier, type NotifyMessage } from './types.js';

export const slackOptionsSchema = z.object({
  botToken: z.string(),
  signingSecret: z.string(),
  channel: z.string(),
  quietHours: z
    .object({ start: z.string(), end: z.string(), timezone: z.string().default('UTC') })
    .nullable()
    .default(null),
  /** Anyone can click a button; only these ids count as a decision. */
  authorisedApprovers: z.array(z.string()).default([]),
  baseUrl: z.string().default('https://slack.com/api'),
});

export type SlackOptions = z.infer<typeof slackOptionsSchema>;

export class SlackNotifier implements Notifier {
  readonly provider = 'slack';
  private readonly options: SlackOptions;
  /** threadKey -> Slack thread ts, so every run update stays in one thread. */
  private readonly threads = new Map<string, string>();

  constructor(
    readonly id: string,
    options: unknown,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.options = slackOptionsSchema.parse(options);
  }

  private async post<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.options.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const payload = (await res.json()) as { ok: boolean; error?: string };
    if (!payload.ok) throw new Error(`Slack ${method} failed: ${payload.error ?? 'unknown error'}`);
    return payload as T;
  }

  async notify(message: NotifyMessage): Promise<void> {
    const linkText = message.links.map((l) => `<${l.url}|${l.label}>`).join(' · ');
    await this.post<{ ts: string }>('chat.postMessage', {
      channel: this.options.channel,
      thread_ts: this.threads.get(message.threadKey),
      text: `${message.title}\n${message.body}${linkText ? `\n${linkText}` : ''}`,
    });
  }

  async requestApproval(request: ApprovalRequest): Promise<{ ticketRef: string }> {
    const result = await this.post<{ ts: string }>('chat.postMessage', {
      channel: this.options.channel,
      text: renderApproval(request),
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: renderApproval(request) } },
        {
          type: 'actions',
          elements: [
            action('✅ Approve', 'primary', `run:${request.runId}:approve`),
            action('✏️ Changes', undefined, `run:${request.runId}:changes`),
            action('❌ Reject', 'danger', `run:${request.runId}:reject`),
          ],
        },
      ],
    });
    this.threads.set(request.threadKey, result.ts);
    return { ticketRef: `slack:${result.ts}` };
  }

  /**
   * Verify a Slack interactivity request.
   *
   * Signature verification is mandatory — the decision payload is otherwise
   * trivially forgeable, and approval is the one gate that matters.
   */
  verifyRequest(input: { timestamp: string; signature: string; rawBody: string }): boolean {
    const age = Math.abs(Date.now() / 1000 - Number(input.timestamp));
    if (!Number.isFinite(age) || age > 300) return false;
    const expected = `v0=${createHmac('sha256', this.options.signingSecret)
      .update(`v0:${input.timestamp}:${input.rawBody}`)
      .digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(input.signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Approver identity comes from the verified payload, never from the button. */
  isAuthorisedApprover(userId: string): boolean {
    return this.options.authorisedApprovers.length === 0
      ? false
      : this.options.authorisedApprovers.includes(userId);
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    try {
      await this.post('auth.test', {});
      return { ok: true, detail: this.options.channel, checkedAt };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), checkedAt };
    }
  }
}

function action(text: string, style: string | undefined, value: string): Record<string, unknown> {
  const element: Record<string, unknown> = {
    type: 'button',
    text: { type: 'plain_text', text },
    value,
    action_id: value,
  };
  if (style) element['style'] = style;
  return element;
}

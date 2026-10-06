import { randomUUID } from 'node:crypto';
import { getMarkdownTheme, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui';
import { REPLY_KINDS, SYMBOL, repairReply, replyHeadline, replyLines, replyProblems, replySchema, row, salvageReply, type Reply, repairToolArgs } from '@prjct.app/pi-tui-kit';

export const ANSWER_TOOL = 'answer';
export const NUDGE_TYPE = 'pi-answer-nudge';

/**
 * The tool's prompt guidelines: Pi renders them into the system prompt on every
 * request while the tool is active. Appending them from before_agent_start
 * flipped the system prompt on automated turns (follow-ups, job reports, team
 * messages), which skip that hook, and each flip threw away the whole cached
 * prefix: 46 of 59 system-prompt cache breaks measured on 2026-09-27/28.
 */
export const SYSTEM_POLICY = [
  `Use \`${ANSWER_TOOL}\` when a structured result helps the person. Plain prose is also a complete reply; do not call the tool just to repeat it.`,
  'Pick the kind that matches what you did: change (you edited files), answer (you were asked something), diagnosis (you investigated a problem), needs_input (you need a decision), blocked (you cannot continue).',
  'Code goes into files with write/edit; in the reply, refer to it by path and line.',
  'Put the result in the fields. Use `explanation` for the why when the person asked for it; do not narrate your process or restate the request.',
];

export const REQUIRED_POLICY = [
  `End every turn by calling \`${ANSWER_TOOL}\` exactly once, alone in its tool batch. It is the only reply the person reads.`,
  ...SYSTEM_POLICY.slice(1),
  'Write no prose outside the tool.',
];

const NUDGE = `Your turn ended without \`${ANSWER_TOOL}\`. Call \`${ANSWER_TOOL}\` now with the result of this turn: no other tool, no prose.`;

/**
 * Replies rejected per prompt before the next one is salvaged as a plain
 * answer: a model that cannot meet the schema still ends its turn.
 */
const MAX_REJECTIONS = 2;

const VERB = 'DONE';
const VERBS = { change: 'CHANGE', answer: 'ANSWER', diagnosis: 'DIAGNOSE', needs_input: 'ASK', blocked: 'BLOCKED' } as const;

/** Only the kinds whose outcome is not a success get a warning tone. */
const toneOf = (reply: Reply): 'success' | 'warning' | 'accent' => {
  if (reply.kind === 'blocked') return 'warning';
  if (reply.kind === 'needs_input') return 'accent';
  if (reply.kind === 'change' && reply.checks.some(check => !check.passed)) return 'warning';
  return 'success';
};

/** The free-text field of each kind; a change has none, its headline is a count. */
const proseOf = (reply: Reply): string | undefined => {
  switch (reply.kind) {
    case 'change': return undefined;
    case 'answer': return reply.answer;
    case 'diagnosis': return reply.cause;
    case 'needs_input': return reply.question;
    case 'blocked': return reply.reason;
  }
};

/** Prose the model wrote is Markdown and renders like any assistant text. */
const markdown = (text: string) => new Markdown(text.trim(), 1, 0, getMarkdownTheme());

/**
 * A reply the model wrote as text instead of calling the tool: the whole text
 * is one JSON object (fenced or not) whose kind, after repair, is a reply kind.
 * MiniMax-M3 answers the reminder this way, and the raw JSON was all the person
 * saw. Anything else (prose, JSON with words around it) is left alone.
 */
export function replyInText(text: string): Record<string, unknown> | undefined {
  const body = text.trim().replace(/^```(?:json)?[ \t]*\n?/iu, '').replace(/\n?```$/u, '').trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const repaired = repairReply(parsed) as { kind?: unknown } | undefined;
  return typeof repaired?.kind === 'string' && (REPLY_KINDS as readonly string[]).includes(repaired.kind)
    && !replyProblems(repaired).length ? parsed as Record<string, unknown> : undefined;
}

type Content = { type: string; text?: string };

/** What a delivered reply keeps: the reply itself and when it reached the person. */
type Delivered = Reply & { deliveredAt?: number };

export type AnswerOptions = Readonly<{ required?: boolean }>;

export function installAnswer(pi: ExtensionAPI, options: AnswerOptions = {}): void {
  const required = options.required ?? process.env.PI_ANSWER_REQUIRED === '1';
  repairToolArgs(pi);
  /**
   * Per prompt: whether the run was already reminded once (a second reminder
   * would only loop) and how many replies were rejected so far.
   */
  const slot = { nudged: false, rejections: 0 };

  pi.registerTool({
    name: ANSWER_TOOL,
    label: 'Answer',
    description: 'An optional structured reply to the person. Call it once, alone, to end the turn. '
      + 'Kinds: change (files you touched, what changed in each, checks you ran, what is pending), '
      + 'answer (the direct answer and file references), diagnosis (cause, evidence by file and line, fix status), '
      + 'needs_input (one question and its options), blocked (why, and what you tried). '
      + 'Code belongs in files; refer to it by path. explanation holds the why when the person asked for it.',
    promptSnippet: 'Deliver a structured result when useful and end the turn',
    promptGuidelines: required ? REQUIRED_POLICY : SYSTEM_POLICY,
    parameters: replySchema(),
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    /**
     * Runs before Pi validates against the union schema. Providers without
     * strict sampling send near-miss shapes (`"refs": ""`, JSON in a string, a
     * wrapped reply): repair fixes the shape, and what is still wrong is named
     * per kind instead of as the union's error for every member.
     */
    prepareArguments(raw: unknown) {
      const reply = repairReply(raw);
      const problems = replyProblems(reply);
      if (!problems.length) return reply;
      slot.rejections += 1;
      if (slot.rejections > MAX_REJECTIONS) return salvageReply(raw);
      throw new Error(`Not delivered. Fix and call ${ANSWER_TOOL} again: ${problems.join('; ')}`);
    },
    // The reply reads like a message, not a tool box: no shell, no pad lines.
    renderShell: 'self',
    async execute(_id: string, input: unknown) {
      // Validated here so the model fixes its own reply while it still has the
      // context; a thrown error goes back to it as the tool result.
      const problems = replyProblems(input);
      if (problems.length) {
        throw new Error(`Not delivered. Fix and call ${ANSWER_TOOL} again: ${problems.join('; ')}`);
      }
      slot.rejections = 0;
      return {
        content: [{ type: 'text' as const, text: 'Delivered.' }],
        details: { ...(input as Reply), deliveredAt: Date.now() } satisfies Delivered,
        terminate: true,
      };
    },
    renderCall(_args: unknown, theme: any, context: any) {
      return context?.isPartial !== false ? row(theme, { symbol: SYMBOL.active, tone: 'accent', verb: VERB, target: 'answering…' }) : new Container();
    },
    renderResult(result: any, _options: unknown, theme: any, context: any) {
      if (context?.isError) {
        const first = result.content?.[0];
        return row(theme, { symbol: SYMBOL.error, tone: 'error', verb: VERB, target: 'reply rejected',
          meta: first?.type === 'text' ? first.text.replace(/\s+/gu, ' ').slice(0, 160) : undefined });
      }
      const reply = result.details as Delivered;
      const prose = proseOf(reply);
      const container = new Container();
      container.addChild(row(theme, { symbol: SYMBOL.ok, tone: toneOf(reply), verb: VERBS[reply.kind], target: prose === undefined ? replyHeadline(reply) : '', at: reply.deliveredAt }));
      if (prose !== undefined) container.addChild(markdown(prose));
      // The first line is the headline or the prose above; the rest are the kind's lists.
      const rest = replyLines({ ...reply, explanation: undefined }).slice(1).flatMap(line => line.split('\n'));
      if (rest.length) container.addChild(new Text(rest.map(line => theme.fg(line.startsWith('  ✗') ? 'error' : 'text', line)).join('\n'), 1, 0));
      if (reply.explanation) {
        container.addChild(new Spacer(1));
        container.addChild(markdown(reply.explanation));
      }
      return container;
    },
  } as Parameters<ExtensionAPI['registerTool']>[0]);

  /**
   * Runs before the message is drawn, saved, or searched for tool calls, so a
   * reply written as text becomes the `answer` call it was meant to be: it
   * renders like any reply, and the history stays a valid call and result.
   */
  pi.on('message_end', async event => {
    // In normal mode, JSON-looking prose is still the model's chosen output.
    // Only explicit structured-answer mode may recover it as a tool call.
    if (!required) return undefined;
    const message = event.message as { role: string; stopReason?: string; content?: Content[] };
    if (message.role !== 'assistant' || message.stopReason !== 'stop' || !pi.getActiveTools().includes(ANSWER_TOOL)) return undefined;
    const content = message.content ?? [];
    if (content.some(part => part.type === 'toolCall')) return undefined;
    const reply = replyInText(content.filter(part => part.type === 'text').map(part => part.text ?? '').join(''));
    if (!reply) return undefined;
    const call = { type: 'toolCall', id: `call_${randomUUID().replace(/-/gu, '').slice(0, 24)}`, name: ANSWER_TOOL, arguments: reply };
    return { message: { ...message, stopReason: 'toolUse', content: [...content.filter(part => part.type !== 'text'), call] } as typeof event.message };
  });

  pi.on('before_agent_start', async event => {
    // A reminder turn carries no prompt of its own; the person's request still rules.
    if (event.prompt.trim()) Object.assign(slot, { nudged: false, rejections: 0 });
    return undefined;
  });

  /**
   * Pi cannot force a tool call, so a run that ends in prose is reminded once.
   * Only when the tool is active: a subagent or a Team Expert that reports
   * through its own tool is never nudged toward this one.
   */
  pi.on('agent_end', async event => {
    if (!required || slot.nudged || !pi.getActiveTools().includes(ANSWER_TOOL)) return;
    const messages = event.messages as { role: string; stopReason?: string; toolName?: string; isError?: boolean }[];
    if (messages.some(message => message.role === 'toolResult' && message.toolName === ANSWER_TOOL && !message.isError)) return;
    const last = messages.filter(message => message.role === 'assistant').at(-1);
    if (!last || last.stopReason !== 'stop') return;
    slot.nudged = true;
    pi.sendMessage({ customType: NUDGE_TYPE, content: NUDGE, display: false }, { triggerTurn: true, deliverAs: 'followUp' });
  });
}

export default function answer(pi: ExtensionAPI): void {
  installAnswer(pi);
}

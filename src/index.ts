import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';
import { SYMBOL, replyHeadline, replyLines, replyProblems, replySchema, row, type Reply } from '@prjct.app/pi-tui-kit';

export const ANSWER_TOOL = 'answer';
export const NUDGE_TYPE = 'pi-answer-nudge';

/**
 * Appended once and never varied, so the cached system prefix stays the same
 * across turns. It orders the reply; the tool checks only its shape.
 */
export const SYSTEM_POLICY = [
  '## How you reply',
  `End every turn by calling \`${ANSWER_TOOL}\` exactly once, alone in its tool batch. It is the only reply the person reads.`,
  'Pick the kind that matches what you did: change (you edited files), answer (you were asked something), diagnosis (you investigated a problem), needs_input (you need a decision), blocked (you cannot continue).',
  'Code goes into files with write/edit; in the reply, refer to it by path and line.',
  'Put the result in the fields. Use `explanation` for the why when the person asked for it; do not narrate your process or restate the request.',
  'Write no prose outside the tool.',
].join('\n');

const NUDGE = `Your turn ended without \`${ANSWER_TOOL}\`. Call \`${ANSWER_TOOL}\` now with the result of this turn: no other tool, no prose.`;

const VERB = 'DONE';
const VERBS = { change: 'CHANGE', answer: 'ANSWER', diagnosis: 'DIAGNOSE', needs_input: 'ASK', blocked: 'BLOCKED' } as const;

/** Only the kinds whose outcome is not a success get a warning tone. */
const toneOf = (reply: Reply): 'success' | 'warning' | 'accent' => {
  if (reply.kind === 'blocked') return 'warning';
  if (reply.kind === 'needs_input') return 'accent';
  if (reply.kind === 'change' && reply.checks.some(check => !check.passed)) return 'warning';
  return 'success';
};

export function installAnswer(pi: ExtensionAPI): void {
  /**
   * Per prompt: whether the run was already reminded once. A second reminder
   * would only loop.
   */
  const slot = { nudged: false };

  pi.registerTool({
    name: ANSWER_TOOL,
    label: 'Answer',
    description: 'Your reply to the person, as data. Call it once, alone, to end the turn. '
      + 'Kinds: change (files you touched, what changed in each, checks you ran, what is pending), '
      + 'answer (the direct answer and file references), diagnosis (cause, evidence by file and line, fix status), '
      + 'needs_input (one question and its options), blocked (why, and what you tried). '
      + 'Code belongs in files; refer to it by path. explanation holds the why when the person asked for it.',
    promptSnippet: 'Reply to the person with typed data and end the turn',
    parameters: replySchema(),
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    async execute(_id: string, input: unknown) {
      // Validated here so the model fixes its own reply while it still has the
      // context; a thrown error goes back to it as the tool result.
      const problems = replyProblems(input);
      if (problems.length) {
        throw new Error(`Not delivered. Fix and call ${ANSWER_TOOL} again: ${problems.join('; ')}`);
      }
      return {
        content: [{ type: 'text' as const, text: 'Delivered.' }],
        details: input as Reply,
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
      const reply = result.details as Reply;
      const container = new Container();
      container.addChild(row(theme, { symbol: SYMBOL.ok, tone: toneOf(reply), verb: VERBS[reply.kind], target: replyHeadline(reply) }));
      // The headline already carries the first line.
      const rest = replyLines(reply).flatMap(line => line.split('\n')).slice(1);
      if (rest.length) container.addChild(new Text(rest.map(line => theme.fg(line.startsWith('  ✗') ? 'error' : 'text', line)).join('\n'), 2, 0));
      return container;
    },
  } as Parameters<ExtensionAPI['registerTool']>[0]);

  pi.on('before_agent_start', async event => {
    // A reminder turn carries no prompt of its own; the person's request still rules.
    if (event.prompt.trim()) slot.nudged = false;
    if (event.systemPrompt.includes(SYSTEM_POLICY) || !pi.getActiveTools().includes(ANSWER_TOOL)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_POLICY}` };
  });

  /**
   * Pi cannot force a tool call, so a run that ends in prose is reminded once.
   * Only when the tool is active: a subagent or a Team Expert that reports
   * through its own tool is never nudged toward this one.
   */
  pi.on('agent_end', async event => {
    if (slot.nudged || !pi.getActiveTools().includes(ANSWER_TOOL)) return;
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

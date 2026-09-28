import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ANSWER_TOOL, NUDGE_TYPE, SYSTEM_POLICY, installAnswer } from '../src/index.ts';

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function harness(active = [ANSWER_TOOL, 'read', 'edit']) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Handler>();
  const sent: { message: any; options: any }[] = [];
  const pi = {
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    sendMessage: (message: any, options: any) => { sent.push({ message, options }); },
    getActiveTools: () => active,
  } as unknown as ExtensionAPI;
  installAnswer(pi);
  const tool = tools.get(ANSWER_TOOL);
  const prompt = (text: string) => handlers.get('before_agent_start')!({ prompt: text, systemPrompt: 'BASE' });
  const end = (messages: any[]) => handlers.get('agent_end')!({ messages });
  return { tool, prompt, end, sent };
}

const change = {
  kind: 'change',
  files: [{ path: 'src/retry.ts', action: 'created', what: 'retry with backoff' }],
  checks: [{ command: 'npm test', passed: true }],
  pending: [],
};

test('a valid reply is delivered and ends the turn', async () => {
  const { tool, prompt } = harness();
  await prompt('agrega retry');
  const result = await tool.execute('1', change);
  assert.equal(result.terminate, true);
  const { deliveredAt, ...reply } = result.details;
  assert.deepEqual(reply, change);
  assert.equal(typeof deliveredAt, 'number');
});

test('a malformed reply goes back to the model; its content is never censored', async () => {
  const { tool, prompt } = harness();
  await prompt('agrega retry');
  await assert.rejects(tool.execute('1', { kind: 'change', checks: [], pending: [] }), /Not delivered/);
  await assert.rejects(tool.execute('1', { summary: 'listo' }), /kind: must be one of/);
  const explained = await tool.execute('1', { ...change, explanation: 'El upstream corta a los 5s.' });
  assert.equal(explained.terminate, true);
  const withCode = await tool.execute('1', { kind: 'answer', answer: 'Llama `retry()` de src/retry.ts', refs: [] });
  assert.equal(withCode.terminate, true);
});

test('the policy is appended once and never varies with the prompt', async () => {
  const { prompt } = harness();
  const first = await prompt('agrega retry');
  const second = await prompt('explícame el retry');
  assert.equal(first.systemPrompt, `BASE\n\n${SYSTEM_POLICY}`);
  assert.deepEqual(first, second);
});

test('a run that ends in prose is reminded exactly once', async () => {
  const { prompt, end, sent } = harness();
  await prompt('agrega retry');
  const prose = [{ role: 'assistant', stopReason: 'stop' }];
  await end(prose);
  await end(prose);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.message.customType, NUDGE_TYPE);
  assert.equal(sent[0]!.options.triggerTurn, true);
  await prompt('ahora el test');
  await end(prose);
  assert.equal(sent.length, 2);
});

test('no reminder after a delivered answer, an abort, or where the tool is not active', async () => {
  const answered = harness();
  await answered.end([{ role: 'assistant', stopReason: 'toolUse' }, { role: 'toolResult', toolName: ANSWER_TOOL, isError: false }]);
  await answered.end([{ role: 'assistant', stopReason: 'aborted' }]);
  assert.equal(answered.sent.length, 0);
  const expert = harness(['read', 'team_reply']);
  assert.equal(await expert.prompt('tarea'), undefined);
  await expert.end([{ role: 'assistant', stopReason: 'stop' }]);
  assert.equal(expert.sent.length, 0);
});

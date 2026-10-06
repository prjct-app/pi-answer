import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ANSWER_TOOL, NUDGE_TYPE, SYSTEM_POLICY, REQUIRED_POLICY, installAnswer } from '../src/index.ts';

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function harness(active = [ANSWER_TOOL, 'read', 'edit'], required = false) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Handler>();
  const sent: { message: any; options: any }[] = [];
  const pi = {
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    sendMessage: (message: any, options: any) => { sent.push({ message, options }); },
    getActiveTools: () => active,
  } as unknown as ExtensionAPI;
  installAnswer(pi, { required });
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

test('the policy rides on the tool, never on a per-turn system prompt', async () => {
  const { tool, prompt } = harness();
  assert.equal(await prompt('agrega retry'), undefined);
  assert.equal(await prompt(''), undefined);
  assert.deepEqual(tool.promptGuidelines, SYSTEM_POLICY);
  assert.ok(SYSTEM_POLICY.some(line => line.includes(ANSWER_TOOL)));
});

test('a prose reply is complete without an automated reminder', async () => {
  const { tool, prompt, end, sent } = harness();
  await prompt('what changed?');
  await end([{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'The tests pass.' }] }]);
  assert.equal(sent.length, 0);
  assert.deepEqual(tool.promptGuidelines, SYSTEM_POLICY);
  assert.ok(SYSTEM_POLICY[0]!.includes('Plain prose'));
});

test('explicit required mode reminds a prose reply exactly once', async () => {
  const { tool, prompt, end, sent } = harness(undefined, true);
  assert.deepEqual(tool.promptGuidelines, REQUIRED_POLICY);
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

test('valid JSON wrappers are accepted without changing the answer', async () => {
  const { tool, prompt } = harness();
  await prompt('qué comando muestra el branch');
  const reply = { kind: 'answer', answer: '`git branch` marca el branch actual con `*`.', refs: [] };
  assert.deepEqual(tool.prepareArguments(JSON.stringify(reply)), reply);
  assert.equal((await tool.execute('1', tool.prepareArguments(reply))).terminate, true);
});

test('what repair cannot fix is named per kind, then salvaged so the turn always ends', async () => {
  const { tool, prompt } = harness();
  await prompt('agrega retry');
  const broken = { kind: 'change', files: ['src/retry.ts'], checks: [], pending: [] };
  assert.throws(() => tool.prepareArguments(broken), /Not delivered.*\/files\/0/);
  assert.throws(() => tool.prepareArguments(broken), /Not delivered/);
  const salvaged = tool.prepareArguments(broken);
  assert.equal(salvaged.kind, 'answer');
  assert.deepEqual(JSON.parse(salvaged.answer), broken);
  assert.equal((await tool.execute('1', salvaged)).terminate, true);
  // A new prompt starts with a clean count.
  await prompt('otra cosa');
  assert.throws(() => tool.prepareArguments(broken), /Not delivered/);
});

test('a reply written as text instead of a tool call becomes the answer call', async () => {
  const handlers = new Map<string, Handler>();
  const pi = {
    registerTool: () => {},
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    sendMessage: () => {},
    getActiveTools: () => [ANSWER_TOOL, 'read'],
  } as unknown as ExtensionAPI;
  installAnswer(pi, { required: true });
  const end = (message: any) => handlers.get('message_end')!({ type: 'message_end', message });
  // MiniMax-M3, 2026-10-03: the reminder answered with the tool's JSON as plain text.
  const json = '{"kind":"answer","answer":"Methodology edited: rule 7 split into 4 sub-states.","refs":[{"path":"docs/methodology.md"}]}';
  const thinking = { type: 'thinking', thinking: 'done', thinkingSignature: 'sig' };
  const replaced = await end({ role: 'assistant', stopReason: 'stop', content: [thinking, { type: 'text', text: json }] });
  assert.equal(replaced.message.stopReason, 'toolUse');
  assert.deepEqual(replaced.message.content[0], thinking, 'thinking stays, with its signature');
  const call = replaced.message.content[1];
  assert.equal(call.type, 'toolCall');
  assert.equal(call.name, ANSWER_TOOL);
  assert.ok(typeof call.id === 'string' && call.id.length > 0, 'a tool call has a nonempty id; its format is not the contract');
  assert.deepEqual(call.arguments, JSON.parse(json));
  assert.equal(replaced.message.content.length, 2, 'the raw JSON text is gone');
  // Fenced JSON too.
  const fenced = await end({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '```json\n{"kind":"blocked","reason":"no access","tried":[]}\n```' }] });
  assert.equal(fenced.message.content[0].name, ANSWER_TOOL);
  // Left alone: prose, JSON with words around it, JSON that is not a reply, a message that already calls tools.
  for (const text of ['Listo, edité docs/methodology.md.', 'Here: {"kind":"answer","answer":"x","refs":[]}', '{"name":"x","value":1}', '{not json}', '{"kind":"answer"}', '{"kind":"change","files":[],"checks":"invalid","pending":[]}']) {
    assert.equal(await end({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] }), undefined, text);
  }
  assert.equal(await end({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: json }, { type: 'toolCall', id: 'c', name: 'read', arguments: {} }] }), undefined);
  assert.equal(await end({ role: 'user', content: [{ type: 'text', text: json }] }), undefined);
});

test('a reply written as text is left alone where the answer tool is not active', async () => {
  const handlers = new Map<string, Handler>();
  installAnswer({
    registerTool: () => {}, sendMessage: () => {},
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    getActiveTools: () => ['read', 'team_reply'],
  } as unknown as ExtensionAPI);
  const json = '{"kind":"answer","answer":"x","refs":[]}';
  assert.equal(await handlers.get('message_end')!({ message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: json }] } }), undefined);
});

test('normal mode preserves JSON-looking prose even when the answer tool is active', async () => {
  const handlers = new Map<string, Handler>();
  installAnswer({ registerTool() {}, sendMessage() {},
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getActiveTools: () => [ANSWER_TOOL],
  } as unknown as ExtensionAPI);
  const message = { role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: '{"kind":"answer","answer":"literal example","refs":[]}'}] };
  assert.equal(await handlers.get('message_end')!({message}), undefined);
});

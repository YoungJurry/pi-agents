import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentControl } from '../control.ts';
import { createCollaborationTools } from '../tools.ts';

const packageRoot = '/tmp/pi-agents';

function fixture(t: TestContext) {
	const control: any = new AgentControl({} as any, path.join(packageRoot, 'index.ts'));
	const caller = '/root/test';
	const ctx = { sessionManager: { getSessionId: () => 'test-session' } };
	control.pathBySessionId.set('test-session', caller);
	t.after(() => control.shutdown());
	return { control, caller, ctx };
}

function track(promise: Promise<any>) {
	const state = { settled: false, promise };
	state.promise = promise.then(value => {
		state.settled = true;
		return value;
	});
	return state;
}

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function mockTimers(t: TestContext) {
	t.mock.timers.enable({ apis: ['setTimeout'] });
}

function dispatcher(control: any): any {
	control.list = () => [];
	return createCollaborationTools(control).find(tool => tool.name === 'agent_action');
}

test('omitted timeout creates no timer and remains pending after seven simulated days', async t => {
	mockTimers(t);
	const { control, caller, ctx } = fixture(t);
	const abort = new AbortController();
	const state = track(control.waitForMailbox(ctx, undefined, abort.signal));
	assert.equal([...control.waiters.get(caller)][0].timer, undefined);
	t.mock.timers.tick(7 * 24 * 60 * 60 * 1000);
	await flush();
	assert.equal(state.settled, false);
	control.notifyMailbox(caller);
	assert.deepEqual(await state.promise, { timedOut: false, aborted: false });
	assert.equal(control.waiters.get(caller).size, 0);
	assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

for (const kind of ['queued mail', 'pending notification']) {
	test(`${kind} returns immediately without creating a waiter`, async t => {
		const { control, caller, ctx } = fixture(t);
		if (kind === 'queued mail') control.pendingMail.set(caller, ['notice']);
		else control.mailboxPending.set(caller, 1);
		assert.deepEqual(await control.waitForMailbox(ctx), { timedOut: false, aborted: false });
		assert.equal(control.waiters.size, 0);
	});
}

for (const [input, expected] of [[1, 10000], [45000, 45000], [3600000, 3600000], [3600001, 3600000]]) {
	test(`explicit timeout ${input} preserves effective duration ${expected}`, async t => {
		mockTimers(t);
		const { control, caller, ctx } = fixture(t);
		const abort = new AbortController();
		const state = track(control.waitForMailbox(ctx, input, abort.signal));
		t.mock.timers.tick(expected - 1);
		await flush();
		assert.equal(state.settled, false);
		t.mock.timers.tick(1);
		assert.deepEqual(await state.promise, { timedOut: true, aborted: false });
		assert.equal(control.waiters.get(caller).size, 0);
		assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
	});
}

for (const timeout of [undefined, 30000]) {
	test(`abort cancels ${timeout === undefined ? 'indefinite' : 'timed'} waiting`, async t => {
		mockTimers(t);
		const { control, caller, ctx } = fixture(t);
		const abort = new AbortController();
		const waiting = control.waitForMailbox(ctx, timeout, abort.signal);
		abort.abort();
		assert.deepEqual(await waiting, { timedOut: false, aborted: true });
		assert.equal(control.waiters.get(caller).size, 0);
		assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
		t.mock.timers.tick(3600000);
	});
}

test('already-aborted signal returns immediately without creating a waiter', async t => {
	const { control, ctx } = fixture(t);
	assert.deepEqual(await control.waitForMailbox(ctx, undefined, AbortSignal.abort()), { timedOut: false, aborted: true });
	assert.equal(control.waiters.size, 0);
});

test('shutdown releases both indefinite and timed waiters', async t => {
	mockTimers(t);
	const { control, ctx } = fixture(t);
	const abort = new AbortController();
	const indefinite = control.waitForMailbox(ctx, undefined, abort.signal);
	const timed = control.waitForMailbox(ctx, 30000, abort.signal);
	await control.shutdown();
	assert.deepEqual(await indefinite, { timedOut: false, aborted: true });
	assert.deepEqual(await timed, { timedOut: false, aborted: true });
	assert.equal(control.waiters.size, 0);
	assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('mailbox wakes all waiters, including explicit timeout, before expiry', async t => {
	mockTimers(t);
	const { control, caller, ctx } = fixture(t);
	const abort = new AbortController();
	const indefinite = control.waitForMailbox(ctx, undefined, abort.signal);
	const timed = control.waitForMailbox(ctx, 30000, abort.signal);
	control.notifyMailbox(caller);
	assert.deepEqual(await indefinite, { timedOut: false, aborted: false });
	assert.deepEqual(await timed, { timedOut: false, aborted: false });
	assert.equal(control.waiters.get(caller).size, 0);
	assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
	t.mock.timers.tick(3600000);
});

test('dispatcher with empty arguments waits indefinitely and returns queued notices', async t => {
	mockTimers(t);
	const { control, caller, ctx } = fixture(t);
	const action = dispatcher(control);
	const state = track(action.execute('test', { action: 'wait_agent', arguments: {} }, undefined, undefined, ctx));
	assert.equal([...control.waiters.get(caller)][0].timer, undefined);
	t.mock.timers.tick(2 * 24 * 60 * 60 * 1000);
	await flush();
	assert.equal(state.settled, false);
	control.pendingMail.set(caller, ['child completed']);
	control.notifyMailbox(caller);
	const result = await state.promise;
	assert.equal(result.details.timedOut, false);
	assert.match(result.content[0].text, /child completed/);
	assert.deepEqual(control.drainPendingMail(caller), []);
});

test('dispatcher preserves explicit timeout and timeout result', async t => {
	mockTimers(t);
	const { control, ctx } = fixture(t);
	const action = dispatcher(control);
	const state = track(action.execute('test', { action: 'wait_agent', arguments: { timeout_ms: 1000 } }, undefined, undefined, ctx));
	t.mock.timers.tick(9999);
	await flush();
	assert.equal(state.settled, false);
	t.mock.timers.tick(1);
	const result = await state.promise;
	assert.equal(result.details.timedOut, true);
	assert.equal(result.content[0].text, 'Wait timed out.');
});

test('dispatcher rejects invalid explicit timeouts', async t => {
	const { control, ctx } = fixture(t);
	const action = dispatcher(control);
	for (const timeout_ms of [0, -1, 3600001, 1.5, null]) {
		await assert.rejects(action.execute('test', { action: 'wait_agent', arguments: { timeout_ms } }, undefined, undefined, ctx), /Invalid arguments for wait_agent/);
	}
	assert.equal(control.waiters.size, 0);
});

test('dispatcher surfaces cancellation for indefinite waiting', async t => {
	const { control, ctx } = fixture(t);
	const action = dispatcher(control);
	const abort = new AbortController();
	const waiting = action.execute('test', { action: 'wait_agent', arguments: {} }, abort.signal, undefined, ctx);
	abort.abort();
	await assert.rejects(waiting, /wait_agent was aborted/);
});

test('catalog and renderer describe the indefinite default accurately', async t => {
	const { control, ctx } = fixture(t);
	const tools: any[] = createCollaborationTools(control);
	const wait = tools.find((tool: any) => tool.name === 'wait_agent');
	const list = tools.find(tool => tool.name === 'list_agents');
	const result = await list.execute('test', { view: 'tools' }, undefined, undefined, ctx);
	const entry = JSON.parse(result.content[0].text).tools.find((tool: any) => tool.name === 'wait_agent');
	assert.match(entry.description, /wait indefinitely unless timeout_ms is provided/);
	assert.match(entry.parameters.properties.timeout_ms.description, /omit to wait indefinitely/);
	const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };
	assert.match(wait.renderCall({}, theme).render(100).join('\n'), /no timeout/);
	assert.doesNotMatch(wait.renderCall({}, theme).render(100).join('\n'), /30000ms/);
	assert.match(wait.renderCall({ timeout_ms: 60000 }, theme).render(100).join('\n'), /60000ms/);
});

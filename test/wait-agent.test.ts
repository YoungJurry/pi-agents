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

test('omitted timeout expires after 30 seconds and cleans up its waiter', async t => {
	mockTimers(t);
	const { control, caller, ctx } = fixture(t);
	const abort = new AbortController();
	const state = track(control.waitForMailbox(ctx, undefined, abort.signal));
	assert.notEqual([...control.waiters.get(caller)][0].timer, undefined);
	t.mock.timers.tick(29999);
	await flush();
	assert.equal(state.settled, false);
	t.mock.timers.tick(1);
	await flush();
	assert.equal(state.settled, true);
	assert.deepEqual(await state.promise, { timedOut: true, aborted: false });
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

for (const [input, expected] of [[1, 10000], [10000, 10000], [45000, 45000], [3600000, 3600000], [3600001, 3600001], [7200000, 7200000], [7200001, 7200000]]) {
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

for (const timeout of [undefined, 7200000]) {
	test(`abort cancels ${timeout === undefined ? 'default' : 'two-hour'} waiting`, async t => {
		mockTimers(t);
		const { control, caller, ctx } = fixture(t);
		const abort = new AbortController();
		const waiting = control.waitForMailbox(ctx, timeout, abort.signal);
		abort.abort();
		assert.deepEqual(await waiting, { timedOut: false, aborted: true });
		assert.equal(control.waiters.get(caller).size, 0);
		assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
		t.mock.timers.tick(7200000);
	});
}

test('already-aborted signal returns immediately without creating a waiter', async t => {
	const { control, ctx } = fixture(t);
	assert.deepEqual(await control.waitForMailbox(ctx, undefined, AbortSignal.abort()), { timedOut: false, aborted: true });
	assert.equal(control.waiters.size, 0);
});

test('shutdown releases both default and two-hour waiters', async t => {
	mockTimers(t);
	const { control, ctx } = fixture(t);
	const abort = new AbortController();
	const defaultWait = control.waitForMailbox(ctx, undefined, abort.signal);
	const timed = control.waitForMailbox(ctx, 7200000, abort.signal);
	await control.shutdown();
	assert.deepEqual(await defaultWait, { timedOut: false, aborted: true });
	assert.deepEqual(await timed, { timedOut: false, aborted: true });
	assert.equal(control.waiters.size, 0);
	assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('mailbox wakes all waiters, before either the default or two-hour deadline', async t => {
	mockTimers(t);
	const { control, caller, ctx } = fixture(t);
	const abort = new AbortController();
	const defaultWait = control.waitForMailbox(ctx, undefined, abort.signal);
	const timed = control.waitForMailbox(ctx, 7200000, abort.signal);
	control.notifyMailbox(caller);
	assert.deepEqual(await defaultWait, { timedOut: false, aborted: false });
	assert.deepEqual(await timed, { timedOut: false, aborted: false });
	assert.equal(control.waiters.get(caller).size, 0);
	assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
	t.mock.timers.tick(7200000);
});

test('dispatcher with empty arguments returns notices before the default deadline', async t => {
	mockTimers(t);
	const { control, caller, ctx } = fixture(t);
	const action = dispatcher(control);
	const state = track(action.execute('test', { action: 'wait_agent', arguments: {} }, undefined, undefined, ctx));
	t.mock.timers.tick(1000);
	await flush();
	assert.equal(state.settled, false);
	control.pendingMail.set(caller, ['child completed']);
	control.notifyMailbox(caller);
	const result = await state.promise;
	assert.equal(result.details.timedOut, false);
	assert.match(result.content[0].text, /child completed/);
	assert.deepEqual(control.drainPendingMail(caller), []);
});

test('dispatcher with empty arguments returns a timeout after 30 seconds', async t => {
	mockTimers(t);
	const { control, ctx } = fixture(t);
	const state = track(dispatcher(control).execute('test', { action: 'wait_agent', arguments: {} }, undefined, undefined, ctx));
	t.mock.timers.tick(29999);
	await flush();
	assert.equal(state.settled, false);
	t.mock.timers.tick(1);
	await flush();
	assert.equal(state.settled, true);
	const result = await state.promise;
	assert.equal(result.details.timedOut, true);
	assert.equal(result.content[0].text, 'Wait timed out.');
});

for (const timeout_ms of [3600001, 7200000]) {
	test(`dispatcher accepts a wait of ${timeout_ms}ms up to two hours`, async t => {
		mockTimers(t);
		const { control, ctx } = fixture(t);
		const state = track(dispatcher(control).execute('test', {
			action: 'wait_agent', arguments: { timeout_ms },
		}, undefined, undefined, ctx));
		t.mock.timers.tick(timeout_ms - 1);
		await flush();
		assert.equal(state.settled, false);
		t.mock.timers.tick(1);
		const result = await state.promise;
		assert.equal(result.details.timedOut, true);
		assert.equal(result.content[0].text, 'Wait timed out.');
	});
}

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
	for (const timeout_ms of [0, -1, 7200001, 1.5, null]) {
		await assert.rejects(action.execute('test', { action: 'wait_agent', arguments: { timeout_ms } }, undefined, undefined, ctx), /Invalid arguments for wait_agent/);
	}
	assert.equal(control.waiters.size, 0);
});

test('dispatcher surfaces cancellation for default waiting', async t => {
	const { control, ctx } = fixture(t);
	const action = dispatcher(control);
	const abort = new AbortController();
	const waiting = action.execute('test', { action: 'wait_agent', arguments: {} }, abort.signal, undefined, ctx);
	abort.abort();
	await assert.rejects(waiting, /wait_agent was aborted/);
});

test('catalog and renderer describe the bounded default and two-hour maximum accurately', async t => {
	const { control, ctx } = fixture(t);
	const tools: any[] = createCollaborationTools(control);
	const wait = tools.find((tool: any) => tool.name === 'wait_agent');
	const list = tools.find(tool => tool.name === 'list_agents');
	const result = await list.execute('test', { view: 'tools' }, undefined, undefined, ctx);
	const entry = JSON.parse(result.content[0].text).tools.find((tool: any) => tool.name === 'wait_agent');
	assert.match(entry.description, /default 30 seconds/);
	assert.match(entry.parameters.properties.timeout_ms.description, /30000/);
	assert.match(entry.parameters.properties.timeout_ms.description, /10000/);
	assert.match(entry.parameters.properties.timeout_ms.description, /7200000/);
	assert.equal(entry.parameters.properties.timeout_ms.maximum, 7200000);
	assert.doesNotMatch(JSON.stringify(entry), /indefinit/i);
	const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };
	assert.match(wait.renderCall({}, theme).render(100).join('\n'), /30000ms/);
	assert.doesNotMatch(wait.renderCall({}, theme).render(100).join('\n'), /no timeout/);
	assert.match(wait.renderCall({ timeout_ms: 60000 }, theme).render(100).join('\n'), /60000ms/);
	assert.match(wait.renderCall({ timeout_ms: 7200000 }, theme).render(100).join('\n'), /7200000ms/);
});

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { AgentControl } from '../control.ts';
import { createCollaborationTools } from '../tools.ts';
import { rootAgentInstructions } from '../context.ts';

const packageRoot = '/tmp/pi-agents';

function fakeSession(id: string, busy = false) {
	const listeners = new Set<(event: any) => void>();
	return {
		sessionId: id,
		isIdle: !busy,
		isStreaming: busy,
		calls: [] as any[],
		disposed: false,
		subscribe(fn: (event: any) => void) { listeners.add(fn); return () => listeners.delete(fn); },
		emit(event: any) { for (const listener of listeners) listener(event); },
		sendCustomMessage(message: any, options: any) {
			this.calls.push({ message, options });
			if (!options.triggerTurn) return Promise.resolve();
			this.isIdle = false;
			this.isStreaming = true;
			return new Promise<void>(() => {});
		},
		async abort() { this.isIdle = true; this.isStreaming = false; },
		dispose() { this.disposed = true; },
	};
}

function fixture(t: TestContext, concurrent = 4, resident = 4) {
	const entries: any[] = [];
	const pi = { appendEntry: (customType: string, data: any) => entries.push({ type: 'custom', customType, data: structuredClone(data) }), sendMessage() {} };
	const control: any = new AgentControl(pi as any, `${packageRoot}/index.ts`, concurrent, resident);
	const caller = '/root/caller';
	const ctx = { cwd: '/tmp', sessionManager: { getSessionId: () => 'caller-session' } };
	control.pathBySessionId.set('caller-session', caller);
	control.root = { sessionId: 'root-session', ctx, cwd: '/tmp', systemPrompt: '' };
	const loads: string[] = [];
	// Keep real residency checks, scheduling, launch, delivery, and persistence;
	// stub only SDK/disk session creation to avoid model calls or user data writes.
	control.ensureLoaded = async (record: any) => {
		if (record.session) { record.loaded = true; return; }
		loads.push(record.path);
		await control.evictForResidency(record.path);
		record.session = fakeSession(record.id);
		record.loaded = true;
		control.subscribe(record);
	};
	function add(name: string, status = 'completed', loaded = false, createdAt = Date.now() - 1000): any {
		const record: any = {
			id: `id-${name}`, path: `/root/${name}`, parentPath: '/root', parentId: 'root-session',
			taskName: name, role: 'default', modelProvider: 'test', modelId: 'model',
			sessionFile: `/tmp/test-only-${name}.jsonl`, status, createdAt, updatedAt: createdAt,
			lastUsedAt: createdAt, lastAssignedAt: createdAt, loaded,
			holdsExecutionSlot: status === 'running', launchGeneration: 0,
		};
		if (loaded) record.session = fakeSession(record.id, status === 'running');
		control.agentsByPath.set(record.path, record);
		control.pathBySessionId.set(record.id, record.path);
		if (record.holdsExecutionSlot) control.activeExecutionSlots++;
		if (record.session) control.subscribe(record);
		return record;
	}
	function fill(count = concurrent) {
		return Array.from({ length: count }, (_, index) => add(`busy_${index}`, 'running', true));
	}
	async function settle(record: any) {
		record.status = 'completed';
		record.session.isIdle = true;
		record.session.isStreaming = false;
		record.session.emit({ type: 'agent_settled' });
		await Promise.resolve();
		await control.schedulerPromise;
		await Promise.resolve();
	}
	function followup(record: any, message = 'follow-up task') {
		return control.message(ctx, { target: record.path, message, triggerTurn: true });
	}
	t.after(() => control.shutdown());
	return { control, caller, ctx, entries, loads, add, fill, settle, followup };
}

test('followup queues an unloaded target when all four residents are busy', async t => {
	const f = fixture(t);
	const busy = f.fill();
	const target = f.add('reused');
	const result = await f.followup(target, 'continue the previous task');
	assert.equal(result.status, 'queued');
	assert.equal(result.queuePosition, 1);
	assert.equal(target.loaded, false);
	assert.equal(target.holdsExecutionSlot, false);
	assert.match(target.queuedMessage, /continue the previous task/);
	assert.equal(f.control.activeExecutionSlots, 4);
	assert.deepEqual(f.loads, []);
	assert.ok(busy.every(record => record.session && !record.session.disposed));
	const saved = f.entries.at(-1).data.agents.find((record: any) => record.path === target.path);
	assert.equal(saved.status, 'queued');
	assert.match(saved.queuedMessage, /continue the previous task/);
	assert.equal(saved.queuedAt, target.queuedAt);
});

test('settled resident automatically starts a queued followup with the same identity', async t => {
	const f = fixture(t);
	const busy = f.fill();
	const target = f.add('reused');
	const original = { id: target.id, sessionFile: target.sessionFile };
	await f.followup(target, 'resume old context');
	await f.settle(busy[0]);
	assert.equal(target.status, 'running');
	assert.equal(target.holdsExecutionSlot, true);
	assert.equal(f.control.activeExecutionSlots, 4);
	assert.deepEqual(f.loads, [target.path]);
	assert.equal(target.id, original.id);
	assert.equal(target.sessionFile, original.sessionFile);
	assert.equal(target.session.calls.length, 1);
	assert.match(target.session.calls[0].message.content, /resume old context/);
	assert.equal(target.queuedMessage, undefined);
	assert.equal(target.queuedAt, undefined);
});

test('loaded idle target queues when concurrency is full', async t => {
	const f = fixture(t, 4, 5);
	const busy = f.fill();
	const target = f.add('resident_idle', 'completed', true);
	assert.equal((await f.followup(target)).status, 'queued');
	assert.equal(target.session.calls.length, 0);
	await f.settle(busy[0]);
	assert.equal(target.status, 'running');
	assert.equal(target.session.calls.length, 1);
	assert.equal(f.control.activeExecutionSlots, 4);
});

test('resident backpressure queues even if an execution slot is available', async t => {
	const f = fixture(t, 4, 4);
	const busy = f.fill();
	f.control.releaseExecutionSlot(busy[0]);
	const target = f.add('unloaded');
	assert.equal((await f.followup(target)).status, 'queued');
	assert.equal(target.status, 'queued');
	assert.equal(f.control.activeExecutionSlots, 3);
	assert.equal(target.loaded, false);
	assert.deepEqual(f.loads, []);
	await f.settle(busy[0]);
	assert.equal(target.status, 'running');
	assert.equal(f.control.activeExecutionSlots, 4);
});

test('followup enters FIFO tail and repeated followups retain position and content', async t => {
	t.mock.method(Date, 'now', () => 10000);
	const f = fixture(t, 1, 1);
	f.fill();
	const target = f.add('very_old', 'completed', false, 1);
	const earlier = f.add('already_queued', 'queued', false, 9000);
	earlier.queuedMessage = 'original queued task';
	earlier.queuedAt = 10000;
	await f.followup(target, 'first instruction');
	const queuedAt = target.queuedAt;
	assert.equal(f.control.queuePosition(earlier), 1);
	assert.equal(f.control.queuePosition(target), 2);
	assert.ok(queuedAt > earlier.queuedAt);
	await f.followup(target, 'second instruction');
	assert.equal(target.queuedAt, queuedAt);
	assert.equal(f.control.queuePosition(target), 2);
	assert.ok(target.queuedMessage.indexOf('first instruction') < target.queuedMessage.indexOf('second instruction'));
	assert.equal(f.control.queuedRecords().filter((record: any) => record.path === target.path).length, 1);
});

test('followup appends to an already-queued original task', async t => {
	const f = fixture(t, 1, 1);
	f.fill();
	const target = f.add('queued', 'queued');
	target.queuedMessage = 'original assignment';
	target.queuedAt = Date.now() - 10;
	await f.followup(target, 'extra instruction');
	assert.equal(target.status, 'queued');
	assert.ok(target.queuedMessage.indexOf('original assignment') < target.queuedMessage.indexOf('extra instruction'));
	assert.deepEqual(f.loads, []);
});

test('followup sent during initialization is included once without duplicate loading', async t => {
	const f = fixture(t, 1, 1);
	const target = f.add('loading');
	const ensureLoaded = f.control.ensureLoaded.bind(f.control);
	let resume!: () => void;
	const gate = new Promise<void>(resolve => { resume = resolve; });
	f.control.ensureLoaded = async (record: any) => { await gate; await ensureLoaded(record); };
	const first = f.followup(target, 'initial continuation');
	assert.equal(target.status, 'pending_init');
	const second = f.followup(target, 'arrived while loading');
	resume();
	await Promise.all([first, second]);
	assert.equal(target.status, 'running');
	assert.deepEqual(f.loads, [target.path]);
	assert.equal(target.session.calls.length, 1);
	const content = target.session.calls[0].message.content;
	assert.equal(content.split('initial continuation').length - 1, 1);
	assert.equal(content.split('arrived while loading').length - 1, 1);
	assert.equal(f.control.activeExecutionSlots, 1);
});

test('followup to an active turn remains mailbox delivery, not a new queued execution', async t => {
	const f = fixture(t);
	const busy = f.fill();
	const target = busy[0];
	f.control.activeTurns.add(target.path);
	await f.followup(target, 'adjust ongoing work');
	assert.equal(target.status, 'running');
	assert.equal(f.control.activeExecutionSlots, 4);
	assert.match(f.control.pendingMail.get(target.path)[0], /adjust ongoing work/);
	assert.equal(f.control.queuedRecords().length, 0);
});

test('non-waking message to an unloaded target uses durable mail without residency errors', async t => {
	const f = fixture(t);
	const busy = f.fill();
	const target = f.add('offline');
	const result = await f.control.message(f.ctx, { target: target.path, message: 'information only', triggerTurn: false });
	assert.equal(result.status, 'completed');
	assert.equal(target.loaded, false);
	assert.match(target.queuedMail[0], /information only/);
	assert.equal(f.control.queuedRecords().length, 0);
	assert.deepEqual(f.loads, []);
	await f.followup(target, 'now act');
	await f.settle(busy[0]);
	assert.match(target.session.calls[0].message.content, /information only/);
	assert.match(target.session.calls[0].message.content, /now act/);
});

test('concurrent followups never exceed execution or residency capacity', async t => {
	const f = fixture(t, 2, 2);
	const targets = Array.from({ length: 6 }, (_, index) => f.add(`target_${index}`));
	await Promise.all(targets.map(target => f.followup(target)));
	assert.equal(f.control.activeExecutionSlots, 2);
	assert.equal(targets.filter(record => record.loaded).length, 2);
	assert.equal(targets.filter(record => record.status === 'running').length, 2);
	assert.equal(targets.filter(record => record.status === 'queued').length, 4);
	assert.equal(f.loads.length, 2);
	await f.settle(targets[0]);
	assert.equal(targets[2].status, 'running');
	assert.equal(f.control.activeExecutionSlots, 2);
	assert.equal(targets.filter(record => record.loaded).length, 2);
});

test('idle followup still starts immediately when capacity is available', async t => {
	const f = fixture(t);
	const target = f.add('idle');
	assert.equal((await f.followup(target)).status, 'running');
	assert.equal(target.session.calls.length, 1);
	assert.equal(f.control.activeExecutionSlots, 1);
});

test('queued followups and queue timestamps survive state restoration', async t => {
	const f = fixture(t, 1, 1);
	f.fill();
	const target = f.add('persisted');
	await f.followup(target, 'resume after reload');
	const snapshot = structuredClone(f.entries);
	const restored: any = new AgentControl({} as any, `${packageRoot}/index.ts`, 1, 1);
	t.after(() => restored.shutdown());
	restored.restoreState({ sessionManager: { getSessionId: () => 'root-session', getBranch: () => snapshot } });
	const record = restored.agentsByPath.get(target.path);
	assert.equal(record.status, 'queued');
	assert.equal(record.loaded, false);
	assert.equal(record.id, target.id);
	assert.equal(record.queuedMessage, target.queuedMessage);
	assert.equal(record.queuedAt, target.queuedAt);
	assert.equal(restored.queuePosition(record), 1);
});

test('queued followup can be interrupted without loading', async t => {
	const f = fixture(t, 1, 1);
	f.fill();
	const target = f.add('cancelled');
	await f.followup(target);
	assert.equal((await f.control.interrupt(f.ctx, target.path)).status, 'interrupted');
	assert.equal(target.queuedMessage, undefined);
	assert.equal(target.queuedMail, undefined);
	assert.equal(target.queuedAt, undefined);
	assert.deepEqual(f.loads, []);
});

test('followup tool schema and root prompt stay unchanged', async t => {
	const f = fixture(t);
	const tools: any[] = createCollaborationTools(f.control);
	const followup = tools.find(tool => tool.name === 'followup_task');
	assert.equal(followup.description, 'Assign follow-up work and start the target agent.');
	assert.deepEqual(Object.keys(followup.parameters.properties).sort(), ['message', 'target']);
	assert.equal(followup.parameters.properties.target.description, 'Absolute agent path, child-relative name, or agent session ID');
	assert.equal(followup.parameters.properties.message.description, 'Follow-up task');
	assert.equal(rootAgentInstructions(), '<multi_agent_role>You can use sub-agents when parallel work would materially improve speed or quality.</multi_agent_role>');
	f.fill();
	const target = f.add('via_dispatcher');
	const action = tools.find(tool => tool.name === 'agent_action');
	const result = await action.execute('test', { action: 'followup_task', arguments: { target: target.path, message: 'dispatch continuation' } }, undefined, undefined, f.ctx);
	assert.equal(result.details.targets[0].status, 'queued');
	assert.match(target.queuedMessage, /dispatch continuation/);
});

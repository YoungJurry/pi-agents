import assert from "node:assert/strict";
import test from "node:test";
import { AgentPickerComponent, AgentTranscriptViewer } from "../viewer.ts";

test("transcript navigation uses distinct line, page, top, and bottom keys", () => {
	const viewer = Object.create(AgentTranscriptViewer.prototype) as any;
	viewer.keybindings = {
		matches: (data: string, action: string) => data === action,
	};
	viewer.tui = { requestRender: () => undefined };
	viewer.lastBodyHeight = 10;
	viewer.lastBodyLines = 100;
	viewer.scrollOffset = 90;
	viewer.followTail = true;

	viewer.handleInput("tui.select.up");
	assert.equal(viewer.scrollOffset, 89);
	assert.equal(viewer.followTail, false);

	viewer.handleInput("tui.editor.cursorLeft");
	assert.equal(viewer.scrollOffset, 79);

	viewer.handleInput("t");
	assert.equal(viewer.scrollOffset, 0);
	assert.equal(viewer.followTail, false);

	viewer.handleInput("tui.editor.cursorRight");
	assert.equal(viewer.scrollOffset, 10);

	viewer.handleInput("b");
	assert.equal(viewer.scrollOffset, 90);
	assert.equal(viewer.followTail, true);

	viewer.handleInput("tui.select.pageUp");
	assert.equal(viewer.scrollOffset, 90);
	viewer.handleInput("home");
	assert.equal(viewer.scrollOffset, 90);
});

test("agent picker orders by latest task assignment and moves reused agents to the top", () => {
	let agents: any[] = [
		{ id: "old", path: "/root/old", model: "test/model", status: "completed", loaded: false, lastAssignedAt: 10 },
		{ id: "new", path: "/root/new", model: "test/model", status: "running", loaded: true, lastAssignedAt: 30 },
		{ id: "middle", path: "/root/middle", model: "test/model", status: "completed", loaded: false, lastAssignedAt: 20 },
	];
	const picker = Object.create(AgentPickerComponent.prototype) as any;
	picker.agents = [];
	picker.selectedIndex = 0;
	picker.loadAgents = () => agents;
	picker.refresh();
	assert.deepEqual(picker.agents.map((agent: any) => agent.path), ["/root/new", "/root/middle", "/root/old"]);

	picker.selectedIndex = 2;
	agents = agents.map((agent) => agent.path === "/root/old" ? { ...agent, lastAssignedAt: 40 } : agent);
	picker.refresh();
	assert.deepEqual(picker.agents.map((agent: any) => agent.path), ["/root/old", "/root/new", "/root/middle"]);
	assert.equal(picker.agents[picker.selectedIndex].path, "/root/old");
});

import assert from "node:assert/strict";
import test from "node:test";
import { AgentTranscriptViewer } from "../viewer.ts";

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

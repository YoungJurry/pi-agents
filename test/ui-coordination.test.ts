import assert from "node:assert/strict";
import test from "node:test";
import { AgentControl } from "../control.ts";

test("child permission dialogs wait until the agents overlay closes", async () => {
	const control = new AgentControl({} as any, "/tmp/pi-agents/index.ts");
	let proxiedUi: any;
	let opened = false;
	let receivedTitle = "";
	const rootUi = {
		select: async (title: string) => {
			opened = true;
			receivedTitle = title;
			return "allow";
		},
	};
	(control as any).root = {
		ctx: { hasUI: true, ui: rootUi, mode: "tui" },
	};
	const session = {
		extensionRunner: {
			setUIContext: (ui: unknown) => { proxiedUi = ui; },
		},
	};
	(control as any).attachRootUi({ path: "/root/reviewer" }, session);

	const closeOverlay = control.beginUserOverlay();
	const permission = proxiedUi.select("Allow restricted command?", ["allow", "deny"]);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(opened, false);

	closeOverlay();
	assert.equal(await permission, "allow");
	assert.equal(opened, true);
	assert.equal(receivedTitle, "[/root/reviewer] Allow restricted command?");
});

test("nested user overlays release dialogs only after the last overlay closes", async () => {
	const control = new AgentControl({} as any, "/tmp/pi-agents/index.ts");
	const closeOuter = control.beginUserOverlay();
	const closeInner = control.beginUserOverlay();
	let released = false;
	const waiting = (control as any).waitForUserOverlayClose().then(() => { released = true; });
	closeInner();
	await Promise.resolve();
	assert.equal(released, false);
	closeOuter();
	await waiting;
	assert.equal(released, true);
});

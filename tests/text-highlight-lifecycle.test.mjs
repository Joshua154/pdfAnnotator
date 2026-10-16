import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
	entryPoints: ["src/tools/text-highlight.ts"], bundle: true, write: false, format: "esm",
});
const { TextHighlightTool } = await import(
	`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

test("text highlighting removes its document listener and pending timer on deactivation", () => {
	const doc = new EventTarget();
	const timers = new Map();
	let nextId = 0;
	let selections = 0;
	doc.defaultView = {
		setTimeout(callback) { timers.set(++nextId, callback); return nextId; },
		clearTimeout(id) { timers.delete(id); },
		getSelection() { selections++; return null; },
	};
	const tool = new TextHighlightTool();
	tool.resolveOverlay = () => null;
	const ctx = { getPageContainer: () => ({ ownerDocument: doc }) };
	tool.onActivate(ctx);
	doc.dispatchEvent(new Event("pointerup"));
	assert.equal(timers.size, 1);
	tool.onDeactivate();
	assert.equal(timers.size, 0, "closing the view cancels pending selection capture");
	doc.dispatchEvent(new Event("pointerup"));
	assert.equal(timers.size, 0, "the closed view no longer listens to pointer events");
	tool.onActivate(ctx);
	doc.dispatchEvent(new Event("pointerup"));
	assert.equal(timers.size, 1, "reopening the tool restores one listener");
	for (const callback of timers.values()) callback();
	assert.equal(selections, 1);
	tool.onDeactivate();
});

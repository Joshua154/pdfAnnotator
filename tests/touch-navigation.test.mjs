import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
	stdin: {
		contents: `export * from "./src/touch-navigation";
			export * from "./src/tools/pen";
			export * from "./src/tools/highlighter";
			export * from "./src/tools/shapes";
			export * from "./src/tools/eraser";
			export * from "./src/tools/textbox";
			export * from "./src/annotations/model";
			export * from "./src/history";`,
		resolveDir: process.cwd(),
	},
	bundle: true, write: false, format: "esm",
});
const { TouchNavigation, PenTool, HighlighterTool, ShapeTool, EraserTool, TextBoxTool, createEmptyDocument, addAnnotation, History } = await import(
	`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

function viewer({ pan = true } = {}) {
	const doc = new EventTarget(), win = new EventTarget(), scroll = new EventTarget();
	let now = 0, nextFrame = 0;
	const frames = new Map(), captures = new Set(), transforms = [], canceled = [];
	let finished = 0;
	Object.assign(win, {
		performance: { now: () => now },
		requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
		cancelAnimationFrame(id) { frames.delete(id); },
	});
	doc.defaultView = win;
	Object.assign(scroll, {
		ownerDocument: doc, scrollTop: 100, scrollLeft: 200,
		setPointerCapture: id => captures.add(id),
		hasPointerCapture: id => captures.has(id),
		releasePointerCapture: id => captures.delete(id),
	});
	const target = { closest: () => null };
	const options = {
		shouldPan: () => pan,
		cancelTool: evt => canceled.push(evt.pointerId),
		transform(from, to, scale) {
			transforms.push({ from, to, scale });
			scroll.scrollLeft += from.clientX - to.clientX;
			scroll.scrollTop += from.clientY - to.clientY;
		},
		finish() { finished++; },
	};
	const navigation = new TouchNavigation(scroll, options);
	function send(type, id, x = 100, y = 100, extra = {}) {
		now += 16;
		const evt = new Event(type, { cancelable: true });
		for (const [key, value] of Object.entries({ pointerId: id, pointerType: "touch", button: 0,
			clientX: x, clientY: y, timeStamp: now, target, ...extra })) {
			Object.defineProperty(evt, key, { value });
		}
		(type === "pointerdown" || type.startsWith("touch") ? scroll : doc).dispatchEvent(evt);
		return evt;
	}
	function advance(ms = 16) {
		now += ms;
		const callbacks = [...frames.values()]; frames.clear();
		for (const callback of callbacks) callback(now);
	}
	return { navigation, send, advance, scroll, doc, win, target, options, transforms, canceled, captures, frames, finished: () => finished };
}

test("one finger pans empty Select space in both axes and continues with momentum", () => {
	const v = viewer();
	let taps = 0, strayMoves = 0;
	v.scroll.addEventListener("pointerdown", () => taps++);
	v.doc.addEventListener("pointermove", () => strayMoves++);
	v.send("pointerdown", 1, 100, 150);
	assert.equal(taps, 1, "the initial Select tap can still clear selection");
	assert.equal(v.send("touchstart", 1).defaultPrevented, true);
	v.send("pointermove", 1, 70, 100);
	assert.equal(v.scroll.scrollLeft, 230);
	assert.equal(v.scroll.scrollTop, 150);
	assert.equal(strayMoves, 0);
	v.send("pointerup", 1, 70, 100);
	assert.equal(v.captures.size, 0);
	assert.equal(v.finished(), 1);
	v.advance();
	assert.ok(v.scroll.scrollTop > 150);
	for (let i = 0; i < 160; i++) v.advance();
	assert.equal(v.frames.size, 0, "momentum eventually stops");
	v.navigation.destroy();
});

test("two fingers take over a tool, pinch around their midpoint, and leave one finger panning", () => {
	const v = viewer({ pan: false });
	let toolDowns = 0, toolMoves = 0, toolUps = 0;
	v.scroll.addEventListener("pointerdown", () => toolDowns++);
	v.doc.addEventListener("pointermove", () => toolMoves++);
	v.doc.addEventListener("pointerup", () => toolUps++);
	v.send("pointerdown", 1, 100, 100);
	v.send("pointermove", 1, 110, 100);
	assert.equal(toolMoves, 1);
	v.send("pointerdown", 2, 210, 100);
	assert.equal(toolDowns, 1, "the second finger never starts a tool gesture");
	assert.deepEqual(v.canceled, [1, 2]);
	assert.equal(v.navigation.isZooming, true);
	assert.equal(v.send("touchmove", 1).defaultPrevented, true);
	v.send("pointermove", 2, 310, 100);
	assert.deepEqual(v.transforms[0], {
		from: { clientX: 160, clientY: 100 }, to: { clientX: 210, clientY: 100 }, scale: 2,
	});
	v.send("pointerup", 2, 310, 100);
	v.send("pointermove", 1, 110, 80);
	assert.equal(v.transforms.at(-1).scale, 1);
	assert.equal(v.scroll.scrollTop, 120);
	assert.equal(v.finished(), 0);
	v.send("pointerup", 1, 110, 80);
	assert.equal(v.finished(), 1);
	assert.equal(v.navigation.isZooming, false);
	assert.equal(toolMoves, 1);
	assert.equal(toolUps, 0);
	assert.equal(v.frames.size, 0, "a pinch does not fling the page on release");
	v.navigation.destroy();
});

test("native text scrolling, editors, mouse and stylus events retain their normal behavior", () => {
	const v = viewer({ pan: false });
	v.send("pointerdown", 1);
	assert.equal(v.send("touchstart", 1).defaultPrevented, false);
	assert.equal(v.send("pointermove", 1, 100, 70).defaultPrevented, false);
	v.send("pointerup", 1);
	for (const pointerType of ["mouse", "pen"]) {
		v.send("pointerdown", 2, 100, 100, { pointerType });
		v.send("pointermove", 2, 100, 80, { pointerType });
		v.send("pointerup", 2, 100, 80, { pointerType });
	}
	const editor = { closest: () => ({}) };
	v.send("pointerdown", 3, 100, 100, { target: editor });
	v.send("pointerdown", 4, 150, 100, { target: editor });
	assert.equal(v.transforms.length, 0);
	assert.equal(v.canceled.length, 0);
	v.navigation.destroy();
});

test("cancellation, capture loss, visibility changes, blur and destruction release contacts and stop animation", () => {
	for (const cause of ["pointercancel", "capture", "blur", "hidden", "destroy"]) {
		const v = viewer();
		v.send("pointerdown", 1);
		v.send("pointerdown", 2, 150, 100);
		v.send("pointermove", 2, 200, 100);
		if (cause === "pointercancel") v.send("pointercancel", 1);
		if (cause === "capture") {
			const event = new Event("lostpointercapture");
			Object.defineProperty(event, "pointerId", { value: 1 });
			v.scroll.dispatchEvent(event);
		}
		if (cause === "blur") v.win.dispatchEvent(new Event("blur"));
		if (cause === "hidden") { v.doc.hidden = true; v.doc.dispatchEvent(new Event("visibilitychange")); }
		if (cause === "destroy") v.navigation.destroy();
		assert.equal(v.captures.size, 0, cause);
		assert.equal(v.navigation.isZooming, false, cause);
		assert.equal(v.finished(), 1, cause);
		const count = v.transforms.length;
		v.send("pointermove", 2, 300, 100);
		assert.equal(v.transforms.length, count, cause);
		v.navigation.destroy();
	}
	const v = viewer();
	v.send("pointerdown", 1); v.send("pointermove", 1, 100, 70); v.send("pointerup", 1, 100, 70);
	assert.equal(v.frames.size, 1);
	v.scroll.dispatchEvent(new Event("wheel"));
	assert.equal(v.frames.size, 0);
	v.send("pointerdown", 2); v.send("pointermove", 2, 100, 70); v.send("pointerup", 2, 100, 70);
	v.navigation.destroy();
	assert.equal(v.frames.size, 0);
	const count = v.transforms.length;
	v.send("pointerdown", 3); v.send("pointermove", 3, 100, 70);
	assert.equal(v.transforms.length, count, "destroy removes event listeners");
});

class SvgElement {
	children = []; attributes = {}; style = {}; captures = new Set();
	classList = { add() {} };
	ownerDocument = { createElementNS: () => new SvgElement() };
	setAttribute(key, value) { this.attributes[key] = value; }
	appendChild(child) { this.children.push(child); }
	setPointerCapture(id) { this.captures.add(id); }
	hasPointerCapture(id) { return this.captures.has(id); }
	releasePointerCapture(id) { this.captures.delete(id); }
}

function drawing(ToolClass) {
	const v = viewer({ pan: false }), tool = new ToolClass();
	const doc = createEmptyDocument("Test.pdf"), history = new History(), svg = new SvgElement();
	const overlay = {
		page: 1, scale: 1, svg, draftLayer: new SvgElement(),
		clearDraft() { this.draftLayer.children = []; },
		toPdfPoint: evt => [evt.clientX, evt.clientY],
		hitTest: (items, x) => items.filter(ann => ann.x === x),
		renderItems(items) { this.rendered = structuredClone(items); },
	};
	let saves = 0;
	const ctx = {
		doc, history, options: { penColor: "#000", penWidth: 2, highlighterColor: "#ff0", highlighterWidth: 12, shapeKind: "rect" },
		getPageItems: () => doc.pages.get(1)?.items ?? [],
		requestSave() { saves++; }, requestRender() { overlay.renderItems(ctx.getPageItems()); },
	};
	v.options.cancelTool = evt => tool.onPointerCancel?.(evt, overlay, ctx);
	v.scroll.addEventListener("pointerdown", evt => tool.onPointerDown(evt, overlay, ctx));
	v.doc.addEventListener("pointermove", evt => tool.onPointerMove(evt, overlay, ctx));
	v.doc.addEventListener("pointerup", evt => tool.onPointerUp(evt, overlay, ctx));
	return { ...v, tool, overlay, ctx, doc, history, saves: () => saves };
}

test("pinching cancels pen, highlighter and shape drafts without saving; a fresh stroke still works", (t) => {
	const previousDocument = globalThis.document;
	globalThis.document = { createElementNS: () => new SvgElement() };
	t.after(() => { globalThis.document = previousDocument; });
	for (const ToolClass of [PenTool, HighlighterTool, ShapeTool]) {
		const f = drawing(ToolClass);
		f.send("pointerdown", 1, 10, 20);
		f.send("pointermove", 1, 20, 40);
		f.send("pointerdown", 2, 100, 100);
		assert.equal(f.overlay.draftLayer.children.length, 0);
		assert.equal(f.overlay.svg.captures.size, 0);
		f.send("pointermove", 1, 200, 200);
		f.send("pointerup", 2); f.send("pointerup", 1);
		assert.equal(f.doc.pages.size, 0, ToolClass.name);
		assert.equal(f.history.canUndo, false);
		assert.equal(f.saves(), 0);
		f.send("pointerdown", 3, 10, 20);
		f.send("pointerup", 3, 30, 50);
		assert.equal(f.doc.pages.get(1).items.length, 1);
		assert.equal(f.saves(), 1);
		assert.equal(f.overlay.svg.captures.size, 0);
		f.navigation.destroy();
	}
});

test("canceled erasing preserves the model and history; completed erasing is one reversible step", () => {
	const f = drawing(EraserTool);
	for (const x of [10, 20, 30]) addAnnotation(f.doc, 1, { id: String(x), type: "shape", shape: "rect", x, y: 0, x2: x + 5, y2: 5, color: "#000", width: 1, opacity: 1 });
	const original = structuredClone(f.doc);
	f.send("pointerdown", 1, 10, 0);
	f.send("pointermove", 1, 20, 0);
	assert.deepEqual(f.overlay.rendered.map(ann => ann.id), ["30"]);
	assert.deepEqual(f.doc, original, "autosave cannot persist a partial erase");
	f.send("pointerdown", 2, 100, 100);
	assert.deepEqual(f.overlay.rendered, f.doc.pages.get(1).items);
	f.send("pointerup", 2); f.send("pointerup", 1);
	assert.deepEqual(f.doc, original);
	assert.equal(f.history.canUndo, false);
	f.send("pointerdown", 3, 10, 0);
	f.send("pointermove", 3, 20, 0);
	f.send("pointerup", 3, 20, 0);
	assert.deepEqual(f.doc.pages.get(1).items.map(ann => ann.id), ["30"]);
	assert.equal(f.saves(), 1);
	f.history.undo(f.doc);
	assert.deepEqual(f.doc, original, "undo restores annotation stacking order");
	assert.equal(f.history.canUndo, false);
	f.navigation.destroy();
});

test("touch text placement waits for a tap and never opens an editor during a pinch", () => {
	const f = drawing(TextBoxTool);
	const placements = [];
	f.tool.placeEditor = evt => placements.push([evt.clientX, evt.clientY]);
	f.send("pointerdown", 1, 10, 20);
	assert.equal(placements.length, 0);
	f.send("pointerdown", 2, 100, 100);
	f.send("pointerup", 2); f.send("pointerup", 1);
	assert.equal(placements.length, 0);
	f.send("pointerdown", 3, 30, 40); f.send("pointerup", 3, 30, 40);
	assert.deepEqual(placements, [[30, 40]]);
	f.navigation.destroy();
});

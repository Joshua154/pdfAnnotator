import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
	stdin: {
		contents: `export * from "./src/annotations/model";
			export * from "./src/annotations/store";
			export * from "./src/annotation-clipboard";
			export * from "./src/history";
			export * from "./src/tools/select";
			export * from "./src/view";`,
		resolveDir: process.cwd(),
	},
	bundle: true, write: false, format: "esm",
	plugins: [{
		name: "obsidian-fixture",
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
			build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
				export class FileView {}
				export class Scope {}
				export class TFile {}
				export class TFolder {}
				export class Notice {}
				export class Menu {}
				export class Modal {}
				export class FuzzySuggestModal {}
				export class Component {}
				export class MarkdownRenderer {}
				export const loadMathJax = async () => {};
				export const finishRenderMath = async () => {};
				export const renderMath = () => {};
				export const normalizePath = path => path;
				export const setIcon = () => {};
				export const loadPdfJs = async () => {};
			` }));
		},
	}],
});
const {
	createEmptyDocument, addAnnotation, annotationBBox, cloneAnnotation,
	History, SelectTool, PDFAnnotatorView,
	writeAnnotations, readAnnotations, ANNOTATION_MIME, serializeDocument, parseDocument,
} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);

const shape = (id, x = 10, y = 20) => ({ id, type: "shape", shape: "rect", x, y, x2: x + 40, y2: y + 30, color: "#000", width: 2, opacity: 1 });
const ink = { id: "ink", type: "ink", color: "#000", width: 2, opacity: 1, points: [[10, 20], [30, 40]] };
const highlight = { id: "highlight", type: "text-highlight", color: "#ff0", text: "quoted text", rects: [{ x: 10, y: 20, w: 40, h: 10 }], selection: [0, 1, 2, 3] };
const allTypes = [ink, shape("shape"), highlight,
	{ id: "text", type: "text", x: 10, y: 20, w: 100, h: 30, text: "Hello", color: "#000", fontSize: 14 },
	{ id: "image", type: "image", x: 10, y: 20, w: 100, h: 30, src: "Images/test.png" },
	...["latex", "tikz", "excalidraw"].map(type => ({ id: type, type, x: 10, y: 20, w: 100, h: 30, source: `source for ${type}` })),
];

class ElementFixture {
	children = []; style = {}; attributes = {}; classList = { add() {}, remove() {}, toggle() {} };
	ownerDocument = { createElementNS: () => new ElementFixture() };
	setAttribute(name, value) { this.attributes[name] = value; }
	getAttribute(name) { return this.attributes[name] ?? null; }
	appendChild(child) { this.children.push(child); return child; }
	append(...children) { this.children.push(...children); }
	replaceChildren(...children) { this.children = children; }
	addEventListener() {}
	querySelector() { return null; }
	getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 }; }
	setPointerCapture(id) { this.capture = id; }
	hasPointerCapture(id) { return this.capture === id; }
	releasePointerCapture() { this.capture = undefined; }
}

function fixture({ order = [1, -1, 2, 3], scale = 1 } = {}) {
	const doc = createEmptyDocument("Lecture.pdf"), history = new History();
	if (order.includes(-1)) doc.blankPages.push({ page: -1, afterPage: 1, width: 200, height: 200 });
	const scroll = {
		scrollTop: 0,
		getBoundingClientRect: () => ({ top: 0, bottom: 250, left: 0, right: 300, width: 300, height: 250 }),
	};
	const frames = new Map(); let nextFrame = 0;
	scroll.ownerDocument = { defaultView: {
		requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
		cancelAnimationFrame: id => frames.delete(id),
	} };
	const overlays = new Map(order.map((page, i) => {
		const svg = new ElementFixture(), uiLayer = new ElementFixture();
		return [page, {
			page, scale, pdfWidth: 200, pdfHeight: 200, svg, uiLayer,
			toPdfPoint: evt => [evt.clientX / scale, (evt.clientY + scroll.scrollTop - i * 220 * scale) / scale],
			annotationIdAt: target => target?.id ?? null,
			clearUi: () => uiLayer.replaceChildren(),
			renderItems(items) { this.rendered = structuredClone(items); },
		}];
	}));
	let saves = 0;
	const tool = new SelectTool({ beginEdit() {} });
	const ctx = {
		doc, history, getPageOrder: () => order,
		getPageOverlay: page => overlays.get(page) ?? null,
		getOverlayAtPoint: (x, y) => {
			const index = Math.floor((y + scroll.scrollTop) / (220 * scale));
			if (x < 0 || x > 200 * scale || (y + scroll.scrollTop) % (220 * scale) > 200 * scale) return null;
			return overlays.get(order[index]) ?? null;
		},
		requestRender: page => overlays.get(page)?.renderItems(doc.pages.get(page)?.items ?? []),
		requestSave: () => { saves++; }, getScrollContainer: () => scroll,
	};
	const changes = [];
	history.onChange = (page, layout, pages) => {
		changes.push(pages ?? [page]);
		for (const p of pages ?? [page]) ctx.requestRender(p);
		tool.refresh(ctx);
	};
	const event = (page, x, y, props = {}) => ({
		button: 0, pointerId: 1, target: null,
		clientX: x * scale, clientY: (order.indexOf(page) * 220 + y) * scale - scroll.scrollTop,
		preventDefault() {}, ...props,
	});
	const click = (page, id, shiftKey = false) => {
		const evt = event(page, 20, 30, { target: { id }, shiftKey });
		tool.onPointerDown(evt, overlays.get(page), ctx);
		tool.onPointerUp(evt, overlays.get(page), ctx);
	};
	return { doc, history, tool, ctx, event, click, overlays, changes, scroll, frames, saves: () => saves };
}

class Clipboard {
	values = new Map(); items = [];
	setData(type, value) { this.values.set(type, value); }
	getData(type) { return this.values.get(type) ?? ""; }
}

test("clipboard round-trips every annotation type and rejects foreign or malformed data", () => {
	const items = allTypes.map((ann, pageOffset) => ({ pageOffset, ann }));
	const data = new Clipboard();
	assert.equal(writeAnnotations(data, items), true);
	assert.deepEqual(readAnnotations(data), items);
	data.values.delete(ANNOTATION_MIME);
	assert.deepEqual(readAnnotations(data), items, "plain-text fallback survives stripped custom formats");
	for (const invalid of [null, {}, { version: 2, items }, { version: 1, items: [] },
		{ version: 1, items: [{ pageOffset: -1, ann: ink }] },
		{ version: 1, items: [{ pageOffset: 0, ann: { ...ink, points: [null] } }] },
		{ version: 1, items: [{ pageOffset: 0, ann: { ...shape("bad"), x: "oops" } }] },
	]) {
		data.setData(ANNOTATION_MIME, JSON.stringify(invalid));
		assert.equal(readAnnotations(data), null);
	}
	data.values.clear(); data.setData("text/plain", "ordinary text");
	assert.equal(readAnnotations(data), null);
});

test("Shift-click toggles selection across pages; select all and delete undo atomically with stacking order", () => {
	const f = fixture();
	for (const page of [1, -1, 2]) for (const id of ["under", "middle", "over"]) addAnnotation(f.doc, page, shape(`${page}:${id}`));
	f.click(1, "1:middle"); f.click(-1, "-1:middle", true); f.click(2, "2:middle", true);
	assert.deepEqual(f.tool.copy(f.ctx).map(item => item.pageOffset), [0, 1, 2]);
	f.click(-1, "-1:middle", true);
	assert.deepEqual(f.tool.copy(f.ctx).map(item => item.pageOffset), [0, 2]);
	const before = structuredClone(f.doc);
	assert.equal(f.tool.deleteSelection(f.ctx), true);
	assert.deepEqual(f.changes.at(-1), [1, 2]);
	assert.deepEqual(f.doc.pages.get(1).items.map(a => a.id), ["1:under", "1:over"]);
	f.history.undo(f.doc);
	assert.deepEqual(f.doc, before);
	f.tool.onKeyDown({ key: "a", ctrlKey: true }, f.ctx);
	assert.equal(f.tool.copy(f.ctx).length, 9);
	f.tool.onKeyDown({ key: "Delete" }, f.ctx);
	assert.equal(f.doc.pages.size, 0);
	f.history.undo(f.doc);
	assert.deepEqual([...f.doc.pages].sort(), [...before.pages].sort());
});

test("paste keeps relative pages, sources and geometry, generates fresh IDs, and supports repeated paste and undo", () => {
	const f = fixture();
	for (const ann of allTypes) addAnnotation(f.doc, 1, cloneAnnotation(ann));
	addAnnotation(f.doc, -1, shape("next-page"));
	f.tool.onKeyDown({ key: "a", metaKey: true }, f.ctx);
	const copy = f.tool.copy(f.ctx), before = structuredClone(f.doc);
	assert.equal(f.tool.paste(f.ctx, copy, 2, [30, 40]), true);
	assert.equal(f.doc.pages.get(2).items.length, allTypes.length);
	assert.equal(f.doc.pages.get(3).items.length, 1);
	const pasted = structuredClone(f.doc.pages.get(2).items);
	assert.ok(pasted.every(a => !allTypes.some(original => original.id === a.id)));
	assert.equal(pasted.find(a => a.type === "image").src, "Images/test.png");
	assert.equal(pasted.find(a => a.type === "latex").source, "source for latex");
	assert.equal(pasted.find(a => a.type === "text-highlight").selection, undefined);
	assert.deepEqual(f.doc.pages.get(1), before.pages.get(1));
	f.history.undo(f.doc); assert.deepEqual(f.doc, before);
	f.history.redo(f.doc); assert.deepEqual(f.doc.pages.get(2).items, pasted);
	f.tool.paste(f.ctx, copy, 2, [30, 40]);
	assert.equal(f.doc.pages.get(2).items.length, allTypes.length * 2);
	assert.notEqual(f.doc.pages.get(2).items[0].id, f.doc.pages.get(2).items[allTypes.length].id);
	assert.equal(annotationBBox(f.doc.pages.get(2).items[allTypes.length]).x, annotationBBox(pasted[0]).x + 12);
});

test("insufficient destination pages never partially paste or remove a selection", () => {
	const f = fixture();
	addAnnotation(f.doc, 1, ink); addAnnotation(f.doc, 2, shape("later"));
	f.tool.onKeyDown({ key: "a", ctrlKey: true }, f.ctx);
	const before = structuredClone(f.doc);
	assert.equal(f.tool.paste(f.ctx, f.tool.copy(f.ctx), 2), false);
	assert.deepEqual(f.doc, before); assert.equal(f.history.canUndo, false);
});

test("captured drag moves across several pages at non-default zoom and repaints both pages on undo/redo", () => {
	const f = fixture({ scale: 1.5 });
	addAnnotation(f.doc, 1, shape("move"));
	addAnnotation(f.doc, 3, shape("under"));
	const source = f.overlays.get(1), target = f.overlays.get(3);
	f.tool.onPointerDown(f.event(1, 20, 30, { target: { id: "move" } }), source, f.ctx);
	// Events still belong to the captured source overlay, even over page 3.
	f.tool.onPointerMove(f.event(3, 60, 80), source, f.ctx);
	assert.equal(f.doc.pages.get(1).items[0].x, 10, "preview does not mutate the saved model");
	assert.equal(f.doc.pages.get(3).items.length, 1);
	assert.equal(source.rendered.length, 0);
	assert.equal(target.rendered[1].x, 50);
	f.tool.onPointerUp(f.event(3, 60, 80), source, f.ctx);
	assert.equal(f.doc.pages.has(1), false);
	assert.equal(f.doc.pages.get(3).items[1].x, 50);
	assert.equal(f.doc.pages.get(3).items[1].y, 70);
	assert.equal(source.svg.capture, undefined);
	assert.deepEqual(f.changes.at(-1), [1, 3]);
	assert.equal(f.saves(), 1);
	f.history.undo(f.doc);
	assert.equal(source.rendered[0].x, 10); assert.equal(target.rendered.length, 1);
	f.history.redo(f.doc);
	assert.equal(source.rendered.length, 0); assert.equal(target.rendered.length, 2);
});

test("groups move between overlapping source/destination pages in displayed order", () => {
	const f = fixture();
	for (const [page, id] of [[1, "first"], [-1, "second"], [2, "third"]]) {
		addAnnotation(f.doc, page, shape(`${id}-under`)); addAnnotation(f.doc, page, shape(id)); addAnnotation(f.doc, page, shape(`${id}-over`));
	}
	f.click(1, "first"); f.click(-1, "second", true);
	const before = structuredClone(f.doc), source = f.overlays.get(1);
	f.tool.onPointerDown(f.event(1, 20, 30, { target: { id: "first" } }), source, f.ctx);
	f.tool.onPointerMove(f.event(-1, 30, 40), source, f.ctx);
	f.tool.onPointerUp(f.event(-1, 30, 40), source, f.ctx);
	assert.deepEqual(f.doc.pages.get(-1).items.map(a => a.id), ["second-under", "second-over", "first"]);
	assert.deepEqual(f.doc.pages.get(2).items.map(a => a.id), ["third-under", "third", "third-over", "second"]);
	f.history.undo(f.doc); assert.deepEqual(f.doc, before);
	f.history.redo(f.doc); assert.equal(f.doc.pages.get(-1).items.at(-1).id, "first");
});

test("Escape, pointer cancellation, deactivation and an outside drop restore previews without creating history", () => {
	for (const cancel of [
		f => f.tool.onKeyDown({ key: "Escape" }, f.ctx),
		f => f.tool.onPointerCancel({ pointerId: 1 }, f.overlays.get(1), f.ctx),
		f => f.tool.onDeactivate(f.ctx),
		f => f.tool.onPointerUp(f.event(1, -30, 40), f.overlays.get(1), f.ctx),
	]) {
		const f = fixture(); addAnnotation(f.doc, 1, shape("move"));
		const before = structuredClone(f.doc), source = f.overlays.get(1);
		f.tool.onPointerDown(f.event(1, 20, 30, { target: { id: "move" } }), source, f.ctx);
		f.tool.onPointerMove(f.event(-1, 80, 90), source, f.ctx);
		cancel(f);
		assert.deepEqual(f.doc, before); assert.equal(f.history.canUndo, false);
		assert.equal(source.rendered[0].x, 10); assert.equal(f.overlays.get(-1).rendered.length, 0);
		assert.equal(source.svg.capture, undefined); assert.equal(f.frames.size, 0);
	}
});

test("pointerup resolves the final destination even without a last pointermove", () => {
	const f = fixture(); addAnnotation(f.doc, 1, shape("move"));
	const source = f.overlays.get(1);
	f.tool.onPointerDown(f.event(1, 20, 30, { target: { id: "move" } }), source, f.ctx);
	f.tool.onPointerUp(f.event(2, 30, 40), source, f.ctx);
	assert.equal(f.doc.pages.has(1), false); assert.equal(f.doc.pages.get(2).items[0].x, 20);
});

test("dragging past intermediate pages restores them and does not keep redrawing them", () => {
	const f = fixture(); addAnnotation(f.doc, 1, shape("move")); addAnnotation(f.doc, -1, shape("stay"));
	const source = f.overlays.get(1), intermediate = f.overlays.get(-1);
	f.tool.onPointerDown(f.event(1, 20, 30, { target: { id: "move" } }), source, f.ctx);
	f.tool.onPointerMove(f.event(-1, 40, 50), source, f.ctx);
	assert.equal(intermediate.rendered.length, 2);
	f.tool.onPointerMove(f.event(2, 40, 50), source, f.ctx);
	assert.deepEqual(intermediate.rendered.map(a => a.id), ["stay"]);
	const restored = intermediate.rendered;
	f.tool.onPointerMove(f.event(3, 40, 50), source, f.ctx);
	assert.equal(intermediate.rendered, restored);
	f.tool.onPointerUp(f.event(3, 40, 50), source, f.ctx);
	assert.deepEqual(intermediate.rendered.map(a => a.id), ["stay"]);
});

test("transfers to smaller pages keep groups visible without scaling their contents", () => {
	const f = fixture();
	f.overlays.get(-1).pdfWidth = 100; f.overlays.get(-1).pdfHeight = 100;
	const items = [
		{ pageOffset: 0, ann: { ...allTypes.find(a => a.type === "image"), w: 30, h: 20 } },
		{ pageOffset: 0, ann: { ...allTypes.find(a => a.type === "latex"), x: 50, w: 30, h: 20 } },
	];
	assert.equal(f.tool.paste(f.ctx, items, -1, [90, 90]), true);
	const [image, math] = f.doc.pages.get(-1).items;
	assert.equal(image.x, 30); assert.equal(image.y, 80);
	assert.equal(math.x - image.x, 40); assert.equal(math.x + math.w, 100);
	assert.equal(image.w, 30); assert.equal(image.h, 20);
});

test("group drops requiring nonexistent pages are cancelled as a whole", () => {
	const f = fixture(); addAnnotation(f.doc, 1, ink); addAnnotation(f.doc, 2, shape("later"));
	f.tool.onKeyDown({ key: "a", ctrlKey: true }, f.ctx);
	const before = structuredClone(f.doc), source = f.overlays.get(1);
	f.tool.onPointerDown(f.event(1, 20, 30, { target: { id: "ink" } }), source, f.ctx);
	f.tool.onPointerUp(f.event(2, 20, 30), source, f.ctx);
	assert.deepEqual(f.doc, before); assert.equal(f.history.canUndo, false);
});

test("auto-scroll continues a stationary drag near the edge and stops on release", () => {
	const f = fixture(); addAnnotation(f.doc, 1, shape("move"));
	const source = f.overlays.get(1);
	f.tool.onPointerDown(f.event(1, 20, 30, { target: { id: "move" } }), source, f.ctx);
	const evt = { ...f.event(1, 50, 240), clientY: 240 };
	f.tool.onPointerMove(evt, source, f.ctx);
	for (let i = 0; i < 25; i++) {
		for (const [id, callback] of [...f.frames]) { f.frames.delete(id); callback(i * 16); }
	}
	assert.ok(f.scroll.scrollTop > 200);
	f.tool.onPointerUp(evt, source, f.ctx);
	assert.equal(f.frames.size, 0);
	assert.equal(f.doc.pages.has(1), false);
	assert.ok(f.doc.pages.get(2)?.items.length || f.doc.pages.get(-1)?.items.length);
});

test("single-item resize remains on its source page and is undoable", () => {
	const f = fixture(); const ann = allTypes.find(a => a.type === "image");
	addAnnotation(f.doc, 1, cloneAnnotation(ann)); f.click(1, ann.id);
	const source = f.overlays.get(1), handle = new ElementFixture(); handle.setAttribute("data-handle", "se");
	f.tool.onPointerDown(f.event(1, 110, 50, { target: handle }), source, f.ctx);
	f.tool.onPointerUp(f.event(1, 140, 80), source, f.ctx);
	assert.equal(f.doc.pages.get(1).items[0].w, 130); assert.equal(f.doc.pages.get(1).items[0].h, 60);
	f.history.undo(f.doc); assert.deepEqual(f.doc.pages.get(1).items, [ann]);
});

test("moving text highlights detaches stale text links and survives save/reopen on a blank page", () => {
	const f = fixture(); addAnnotation(f.doc, 1, cloneAnnotation(highlight));
	const source = f.overlays.get(1);
	f.tool.onPointerDown(f.event(1, 20, 25, { target: { id: "highlight" } }), source, f.ctx);
	f.tool.onPointerUp(f.event(-1, 30, 35), source, f.ctx);
	assert.equal(f.doc.pages.get(-1).items[0].selection, undefined);
	const saved = serializeDocument(f.doc, { path: "Lecture.pdf", name: "Lecture.pdf" }, { metadataCache: { fileToLinktext: f => f.path } });
	assert.deepEqual(parseDocument(saved, "Lecture.pdf"), f.doc);
	f.history.undo(f.doc); assert.deepEqual(f.doc.pages.get(1).items[0].selection, highlight.selection);
});

function viewFixture(f) {
	const view = Object.create(PDFAnnotatorView.prototype), listeners = new Map();
	const content = { ownerDocument: {}, contains: target => target?.inView === true };
	Object.assign(view, {
		contentEl: content, annDoc: f.doc, noteFile: { path: "annotations.md" },
		app: { workspace: { getActiveViewOfType: () => view } },
		selectTool: f.tool, activeTool: f.tool, toolCtx: f.ctx,
		registerDomEvent: (_, type, callback) => listeners.set(type, callback),
		currentPageNum: () => -1, setTool() {},
	});
	view.registerClipboardHandlers();
	const dispatch = (type, data, target = { inView: true }) => {
		const evt = { target, clipboardData: data, defaultPrevented: false,
			preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
		listeners.get(type)(evt); return evt;
	};
	return { view, dispatch };
}

test("native cut/copy/paste events target the clicked page and preserve the image paste fallback", () => {
	const f = fixture(); addAnnotation(f.doc, 1, shape("move")); f.click(1, "move");
	const { view, dispatch } = viewFixture(f), data = new Clipboard();
	assert.equal(dispatch("copy", data).defaultPrevented, true); assert.equal(f.doc.pages.get(1).items.length, 1);
	assert.equal(dispatch("cut", data).defaultPrevented, true); assert.equal(f.doc.pages.has(1), false);
	view.pasteTarget = { page: 2, point: [50, 60] };
	assert.equal(dispatch("paste", data).defaultPrevented, true);
	assert.equal(f.doc.pages.has(-1), false); assert.equal(annotationBBox(f.doc.pages.get(2).items[0]).x, 50);
	f.history.undo(f.doc); f.history.undo(f.doc); assert.equal(f.doc.pages.get(1).items[0].id, "move");
	const image = { type: "image/png" }, imageClipboard = new Clipboard();
	imageClipboard.items = [{ kind: "file", type: image.type, getAsFile: () => image }];
	let received; view.pasteImage = value => { received = value; };
	assert.equal(dispatch("paste", imageClipboard).defaultPrevented, true); assert.equal(received, image);
});

test("clipboard handlers leave editors, modals, other panes, inactive views, and failed writes untouched", () => {
	const f = fixture(); addAnnotation(f.doc, 1, shape("move")); f.click(1, "move");
	const { view, dispatch } = viewFixture(f), data = new Clipboard();
	writeAnnotations(data, [{ pageOffset: 0, ann: ink }]);
	for (const target of [{ inView: true, isContentEditable: true }, { inView: true, closest: () => ({}) }, { inView: false }]) {
		for (const type of ["copy", "cut", "paste"]) assert.equal(dispatch(type, data, target).defaultPrevented, false);
	}
	const failed = { setData() { throw new Error("unavailable"); } };
	assert.equal(dispatch("cut", failed).defaultPrevented, false);
	assert.equal(f.doc.pages.get(1).items.length, 1);
	view.app.workspace.getActiveViewOfType = () => ({});
	assert.equal(dispatch("paste", data).defaultPrevented, false);
	assert.equal(f.history.canUndo, false);
});

test("view hit testing resolves blank and not-yet-rendered PDF overlays from coordinates, not captured targets", () => {
	const previousDocument = globalThis.document;
	globalThis.document = { createElementNS: () => new ElementFixture() };
	try {
		const view = Object.create(PDFAnnotatorView.prototype);
		const page = { page: 5, container: new ElementFixture(), pdfWidth: 200, pdfHeight: 200, overlay: null };
		Object.assign(view, { pageEls: [page], zoom: 1.5, scrollEl: new ElementFixture(), annDoc: createEmptyDocument("Lecture.pdf") });
		const overlay = view.overlayAtPoint(20, 30);
		assert.equal(overlay.page, 5); assert.equal(page.overlay, overlay); assert.equal(page.rendered, undefined);
		assert.equal(overlay.svg.style.width, "300px");
		assert.equal(view.overlayAtPoint(-1, 30), null);
		assert.equal(view.overlayAtPoint(20, 230), null);
	} finally { globalThis.document = previousDocument; }
});

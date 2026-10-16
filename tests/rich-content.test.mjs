import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
	stdin: {
		contents: `export * from "./src/annotations/model";
			export * from "./src/annotations/store";
			export * from "./src/history";
			export * from "./src/overlay";
			export * from "./src/rich-content";
			export * from "./src/insert-modal";
			export { PDFAnnotatorView } from "./src/view";
			export { fixture, TFile, Component } from "obsidian";`,
		resolveDir: process.cwd(),
	},
	bundle: true, write: false, format: "esm",
	plugins: [{
		name: "obsidian-fixture",
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
			build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
				export const fixture = { components: [], render: async () => {}, math: async () => {} };
				export class Component {
					children = []; loaded = false;
					constructor() { fixture.components.push(this); }
					load() { this.loaded = true; this.children.forEach(child => child.load()); }
					unload() { this.loaded = false; this.children.forEach(child => child.unload()); }
					addChild(child) { this.children.push(child); if (this.loaded) child.load(); return child; }
				}
				export class MarkdownRenderer { static render(...args) { return fixture.render(...args); } }
				export const loadMathJax = () => fixture.math();
				export const renderMath = source => { fixture.expression = source; return document.createElement('svg'); };
				export const finishRenderMath = async () => {};
				export class Modal {
					constructor(app) { this.app = app; this.contentEl = document.createElement('div'); this.modalEl = document.createElement('div'); }
					setTitle(title) { this.title = title; }
					open() { this.opened = true; this.onOpen?.(); }
					close() { this.opened = false; this.onClose?.(); }
				}
				export class FuzzySuggestModal extends Modal { setPlaceholder() {} }
				export class FileView {}
				export class Scope {}
				export class Menu {}
				export class TFile {}
				export class TFolder {}
				export class Notice {}
				export const normalizePath = path => path;
				export const setIcon = () => {};
				export const loadPdfJs = async () => {};
			` }));
		},
	}],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
const {
	createEmptyDocument, addAnnotation, annotationBBox, translateAnnotation, scaleAnnotation,
	serializeDocument, parseDocument, History, AddCommand, UpdateCommand, RemoveCommand,
	PageOverlay, annotationHit, mathSource, tikzMarkdown, isExcalidrawFile,
	mountRichContent, SourceModal, ExcalidrawPicker, PDFAnnotatorView, fixture, TFile, Component,
} = api;
const pdf = { path: "Lecture.pdf", name: "Lecture.pdf" };
const app = { metadataCache: { fileToLinktext: file => file.path } };
const annotations = [
	{ id: "equation", type: "latex", source: String.raw`\frac{x}{2} = \alpha`, x: 20, y: 30, w: 240, h: 80 },
	{ id: "diagram", type: "tikz", source: String.raw`\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}`, x: 30, y: 150, w: 300, h: 220 },
	{ id: "drawing", type: "excalidraw", source: "Drawings/My sketch.excalidraw.md", x: 40, y: 400, w: 300, h: 220 },
];

test("all inserted types round-trip on PDF and blank pages, retaining editable source", () => {
	const doc = createEmptyDocument(pdf.path);
	doc.blankPages.push({ page: -1, afterPage: 1, width: 612, height: 792 });
	for (const page of [1, -1]) for (const ann of annotations) addAnnotation(doc, page, { ...ann });
	const saved = serializeDocument(doc, pdf, app);
	assert.match(saved, /- LaTeX:/);
	assert.match(saved, /- TikZ:/);
	assert.match(saved, /- Excalidraw: !\[\[Drawings\/My sketch.excalidraw.md\]\]/);
	const restored = parseDocument(saved, pdf.path);
	assert.deepEqual([...restored.pages], [...doc.pages]);
	assert.deepEqual(restored.blankPages, doc.blankPages);
});

test("source resembling an annotation block cannot add pages through the readable summary", () => {
	const doc = createEmptyDocument(pdf.path);
	const embeddedBlock = '```pdf-annotations\n' + JSON.stringify({ page: 9, items: [annotations[0]] }) + '\n```';
	addAnnotation(doc, 1, { ...annotations[1], source: embeddedBlock });
	const restored = parseDocument(serializeDocument(doc, pdf, app), pdf.path);
	assert.deepEqual([...restored.pages], [...doc.pages]);
});

test("malformed rich entries are ignored without dropping neighboring annotations", () => {
	const valid = annotations[0];
	const items = [valid, ...[
		{ source: "" }, { source: {} }, { x: "10" }, { y: null }, { w: 0 }, { h: -1 },
	].map((change, i) => ({ ...valid, id: `invalid-${i}`, ...change }))];
	const restored = parseDocument('```pdf-annotations\n' + JSON.stringify({ page: 1, items }) + '\n```', pdf.path);
	assert.deepEqual(restored.pages.get(1).items, [valid]);
});

test("rich annotations move, resize, erase, and undo/redo without losing their sources", () => {
	for (const original of annotations) {
		const doc = createEmptyDocument(pdf.path);
		const history = new History();
		history.execute(doc, new AddCommand(1, original));
		const after = structuredClone(original);
		translateAnnotation(after, 10, -5);
		const bounds = annotationBBox(after);
		const resized = { x: 0, y: 10, w: bounds.w * 2, h: bounds.h / 2 };
		scaleAnnotation(after, bounds, resized);
		assert.deepEqual(annotationBBox(after), resized);
		assert.equal(after.source, original.source);
		assert.equal(annotationHit(after, 20, 20, 0), true);
		assert.equal(annotationHit(after, -20, -20, 0), false);
		history.execute(doc, new UpdateCommand(1, original, after));
		history.execute(doc, new RemoveCommand(1, after));
		assert.equal(doc.pages.size, 0);
		history.undo(doc);
		assert.deepEqual(doc.pages.get(1).items, [after]);
		history.undo(doc);
		assert.deepEqual(doc.pages.get(1).items, [original]);
		history.redo(doc);
		assert.deepEqual(doc.pages.get(1).items, [after]);
	}
});

test("math delimiters and bare TikZ environments are accepted", () => {
	for (const value of ["x^2", "$x^2$", "$$x^2$$", String.raw`\[x^2\]`, String.raw`\(x^2\)`]) {
		assert.equal(mathSource(value), "x^2");
	}
	assert.match(tikzMarkdown(annotations[1].source), /\\begin\{document\}/);
	assert.equal((tikzMarkdown("\\begin{document}\nx\n\\end{document}").match(/\\begin\{document\}/g) ?? []).length, 1);
	assert.ok(tikzMarkdown("```\nx").startsWith("````tikz\n"));
});

class ElementFixture extends EventTarget {
	constructor(tag = "div", ownerDocument = globalThis.document) {
		super(); this.tagName = tag; this.ownerDocument = ownerDocument;
	}
	children = []; style = {}; attributes = {}; value = ""; hidden = false;
	clientWidth = 300; clientHeight = 200; scrollWidth = 600; scrollHeight = 300;
	classList = { add() {}, remove() {}, toggle() {} };
	addClass() {}
	setAttribute(name, value) { this.attributes[name] = value; }
	getAttribute(name) { return this.attributes[name]; }
	appendChild(child) { return this.insertBefore(child, null); }
	insertBefore(child, before) {
		if (child === before) return child;
		child.remove();
		this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
		child.parent = this;
		return child;
	}
	append(...children) { children.forEach(child => this.appendChild(child)); }
	remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
	replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
	empty() { this.replaceChildren(); }
	createEl(tag, options = {}) {
		const child = new ElementFixture(tag, this.ownerDocument);
		child.className = options.cls ?? "";
		child.textContent = options.text ?? "";
		for (const [key, value] of Object.entries(options.attr ?? {})) child.setAttribute(key, value);
		return this.appendChild(child);
	}
	createDiv(options) { return this.createEl("div", options); }
	querySelector(selector) {
		for (const child of this.children) {
			if (selector.split(/,\s*/).some(part => part.startsWith(".")
				? child.className?.split(" ").includes(part.slice(1)) : child.tagName === part)) return child;
			const match = child.querySelector(selector);
			if (match) return match;
		}
		return null;
	}
	focus() {}
	select() {}
}

function dom(t) {
	const previous = Object.fromEntries(["document", "ResizeObserver", "MutationObserver"].map(key => [key, globalThis[key]]));
	const frames = new Map();
	const observers = [];
	let nextFrame = 0;
	globalThis.document = {
		createElement: tag => new ElementFixture(tag), createElementNS: (_, tag) => new ElementFixture(tag),
		defaultView: {
			requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
			cancelAnimationFrame: id => frames.delete(id),
		},
	};
	globalThis.ResizeObserver = globalThis.MutationObserver = class {
		constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
		observe() {}
		disconnect() { this.disconnected = true; }
	};
	fixture.components = []; fixture.render = async () => {}; fixture.math = async () => {};
	t.after(() => Object.assign(globalThis, previous));
	return { frames, observers, flush() { for (const [id, callback] of frames) { frames.delete(id); callback(); } } };
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test("moving or resizing reuses previews; source edits, deletion, and close clean them up", t => {
	dom(t);
	let mounts = 0, disposals = 0;
	const overlay = new PageOverlay(new ElementFixture(), 1, 612, 792, () => {
		mounts++; return () => { disposals++; };
	});
	const ann = { ...annotations[0] };
	overlay.renderItems([ann]);
	const group = overlay.itemsLayer.children[0];
	ann.x += 12; ann.w += 50;
	overlay.renderItems([ann]);
	assert.equal(mounts, 1);
	assert.equal(overlay.itemsLayer.children[0], group);
	assert.equal(group.children[0].attributes.x, String(ann.x));
	assert.equal(group.children[1].attributes.width, String(ann.w));
	overlay.renderItems([{ ...ann, source: "x^3" }]);
	assert.equal(mounts, 2); assert.equal(disposals, 1);
	overlay.renderItems([]);
	assert.equal(disposals, 2);
	overlay.renderItems(annotations);
	overlay.destroy();
	assert.equal(disposals, 5);
});

test("preview fits rendered math and cleans observers, frames, and components", async t => {
	const state = dom(t);
	const host = new ElementFixture();
	const dispose = mountRichContent(app, annotations[0], host, "Annotations/Lecture.md");
	await settle(); state.flush();
	assert.equal(fixture.expression, annotations[0].source);
	assert.equal(host.children[0].hidden, true);
	assert.match(host.children[1].style.transform, /scale\(/);
	state.observers[0].callback();
	assert.equal(state.frames.size, 1);
	dispose();
	assert.equal(state.frames.size, 0);
	assert.ok(state.observers.every(observer => observer.disconnected));
	assert.ok(fixture.components.every(component => !component.loaded));
	assert.equal(host.children.length, 0);
});

test("closing before MathJax loads cannot repopulate a disposed preview", async t => {
	dom(t);
	let finish;
	fixture.math = () => new Promise(resolve => { finish = resolve; });
	const host = new ElementFixture();
	const dispose = mountRichContent(app, annotations[0], host, "Annotations/Lecture.md");
	dispose(); finish(); await settle();
	assert.equal(host.children.length, 0);
	assert.ok(fixture.components.every(component => !component.loaded));
});

test("late plugin results are cleaned up and missing renderers give a useful message", async t => {
	const state = dom(t);
	let finish;
	fixture.render = async (_app, markdown, content, sourcePath, component) => {
		assert.match(markdown, /^```tikz/);
		assert.equal(sourcePath, "Annotations/Lecture.md");
		await new Promise(resolve => { finish = resolve; });
		component.addChild(new Component());
	};
	const host = new ElementFixture();
	const dispose = mountRichContent(app, annotations[1], host, "Annotations/Lecture.md");
	dispose(); finish(); await settle();
	assert.ok(fixture.components.every(component => !component.loaded));
	assert.equal(state.frames.size, 0);
	fixture.render = async (_app, _markdown, content) => {
		// A code block's copy button must not be mistaken for a rendered diagram.
		content.createEl("button").createEl("svg");
	};
	const cleanup = mountRichContent(app, annotations[1], host, "Annotations/Lecture.md");
	await settle(); state.flush();
	assert.match(host.children[0].textContent, /Enable a TikZ code-block renderer/);
	cleanup();
});

test("asynchronous TikZ replacement and Excalidraw embeds become visible when ready", async t => {
	const state = dom(t);
	let renderedContent;
	fixture.render = async (_app, _markdown, content) => { renderedContent = content; };
	const host = new ElementFixture();
	const cleanup = mountRichContent(app, annotations[1], host, "Annotations/Lecture.md");
	await settle(); state.flush();
	assert.equal(host.children[0].hidden, false);
	renderedContent.createDiv({ cls: "block-language-tikz" }).createEl("svg");
	state.observers[1].callback(); state.flush();
	assert.equal(host.children[0].hidden, true);
	cleanup();
	const drawing = Object.assign(new TFile(), { path: annotations[2].source });
	const drawApp = {
		vault: { getAbstractFileByPath: path => path === drawing.path ? drawing : null },
		fileManager: {
			generateMarkdownLink(file, sourcePath, subpath, alias) {
				assert.equal(file, drawing);
				assert.equal(sourcePath, "Annotations/Lecture.md");
				return `[[${file.path}|${alias}]]`;
			},
		},
	};
	fixture.render = async (_app, markdown, content) => {
		assert.equal(markdown, `![[${drawing.path}|600]]`);
		content.createEl("img", { cls: "excalidraw-embedded-img" });
	};
	const dispose = mountRichContent(drawApp, annotations[2], host, "Annotations/Lecture.md");
	await settle(); state.flush();
	assert.equal(host.children[0].hidden, true);
	dispose();
});

test("drawing picker includes custom Markdown drawings and reports missing linked files", async t => {
	const state = dom(t);
	const files = ["Sketch.excalidraw", "Folder/Sketch.excalidraw.md", "Custom.md", "Note.md", "Image.png"]
		.map(path => Object.assign(new TFile(), { path, extension: path.split(".").at(-1) }));
	const drawApp = {
		vault: { getFiles: () => files, getAbstractFileByPath: () => null },
		metadataCache: { getFileCache: file => file.path === "Custom.md" ? { frontmatter: { "excalidraw-plugin": "parsed" } } : null },
	};
	assert.deepEqual(files.map(file => isExcalidrawFile(drawApp, file)), [true, true, true, false, false]);
	let picked;
	const picker = new ExcalidrawPicker(drawApp, file => { picked = file; });
	assert.deepEqual(picker.getItems(), files.slice(0, 3));
	picker.onChooseItem(files[2]); assert.equal(picked, files[2]);
	const host = new ElementFixture();
	const dispose = mountRichContent(drawApp, annotations[2], host, "Annotations/Lecture.md");
	await settle(); state.flush();
	assert.match(host.children[0].textContent, /Drawing not found/);
	dispose();
});

test("source editor validates empty math, previews edits, saves, and cancels without mutation", async t => {
	dom(t);
	const saves = [];
	const modal = new SourceModal(app, "latex", "Annotations/Lecture.md", "x^2", source => saves.push(source));
	modal.open();
	const input = modal.contentEl.querySelector("textarea");
	const actions = modal.contentEl.querySelector(".pdfann-source-actions");
	input.value = "$$ $$";
	actions.children[2].dispatchEvent(new Event("click"));
	assert.deepEqual(saves, []);
	assert.match(modal.contentEl.querySelector(".pdfann-source-error").textContent, /Enter source/);
	input.value = "$$ x^3 $$";
	input.dispatchEvent(new Event("input"));
	actions.children[0].dispatchEvent(new Event("click"));
	await settle();
	assert.equal(fixture.expression, "x^3");
	actions.children[2].dispatchEvent(new Event("click"));
	assert.deepEqual(saves, ["x^3"]);
	assert.equal(modal.opened, false);
	const cancelled = new SourceModal(app, "latex", "Annotations/Lecture.md", "x", source => saves.push(source));
	cancelled.open();
	cancelled.contentEl.querySelector("textarea").value = "different";
	cancelled.close(); await settle();
	assert.deepEqual(saves, ["x^3"]);
	assert.ok(fixture.components.every(component => !component.loaded));
});

test("insertion targets the current blank page and stale dialogs cannot write into another PDF", t => {
	dom(t);
	const doc = createEmptyDocument(pdf.path);
	const page = { page: -1, pdfWidth: 612, pdfHeight: 792 };
	const view = Object.create(PDFAnnotatorView.prototype);
	let saves = 0;
	Object.assign(view, {
		app, annDoc: doc, history: new History(), noteFile: { path: "Annotations/Lecture.md" },
		pageEls: [page], tools: new Map(), scrollEl: null,
		currentPageNum: () => -1, setTool() {}, scheduleSave: () => { saves++; },
	});
	view.insertRich("latex");
	view.insertionModal.onSubmit("x^2");
	assert.equal(doc.pages.get(-1).items[0].source, "x^2");
	assert.equal(saves, 1);
	view.history.undo(doc); assert.equal(doc.pages.size, 0);
	view.history.redo(doc); assert.equal(doc.pages.get(-1).items.length, 1);
	view.insertRich("tikz");
	const stale = view.insertionModal;
	view.noteFile = { path: "Annotations/Another.md" };
	stale.onSubmit("stale diagram");
	assert.equal(doc.pages.get(-1).items.length, 1);
	view.deactivateTools();
});

import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
	stdin: {
		contents: `export * from "./src/annotations/model";
			export * from "./src/annotations/store";
			export * from "./src/history";
			export { PDFAnnotatorView } from "./src/view";`,
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
				export const loadPdfJs = () => { throw new Error("Blank pages must not request PDF rendering"); };
			` }));
		},
	}],
});
const {
	createEmptyDocument, createBlankPage, documentPageOrder, addAnnotation,
	serializeDocument, parseDocument, History, InsertBlankPageCommand, AddCommand, RemoveCommand,
	PDFAnnotatorView,
} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);

const pdf = { path: "Lecture.pdf", name: "Lecture.pdf" };
const app = { metadataCache: { fileToLinktext: file => file.path } };
const ink = { id: "stroke", type: "ink", color: "#000000", width: 2, opacity: 1, points: [[10, 20], [30, 40]] };
function insert(doc, history, after, width = 612, height = 792) {
	const blank = createBlankPage(doc, after, width, height);
	history.execute(doc, new InsertBlankPageCommand(doc, blank, after));
	return blank.page;
}

test("insertion preserves PDF annotation identities and orders multiple blank pages", () => {
	const doc = createEmptyDocument(pdf.path);
	const history = new History();
	addAnnotation(doc, 2, ink);
	const first = insert(doc, history, 1);
	const second = insert(doc, history, first);
	const between = insert(doc, history, first);
	const last = insert(doc, history, 3, 800, 600);
	assert.deepEqual(documentPageOrder(doc, 3), [1, first, between, second, 2, 3, last]);
	assert.equal(doc.pages.get(2).items[0], ink);
	assert.deepEqual(doc.blankPages.at(-1), { page: last, afterPage: 3, width: 800, height: 600 });
});

test("save and reopen retain empty paper, dimensions, ordering, and annotations", () => {
	const doc = createEmptyDocument(pdf.path);
	const history = new History();
	const blank = insert(doc, history, 1, 800, 600);
	insert(doc, history, blank, 800, 600);
	addAnnotation(doc, blank, ink);
	addAnnotation(doc, 2, { ...ink, id: "pdf-stroke" });
	const saved = serializeDocument(doc, pdf, app);
	assert.match(saved, /version: 2/);
	assert.match(saved, /## Blank page 1 after PDF page 1/);
	assert.match(saved, /## \[Page 2\]\(Lecture.pdf#page=2\)/);
	assert.doesNotMatch(saved, /#page=-/);
	const loaded = parseDocument(saved, pdf.path);
	assert.deepEqual(loaded.blankPages, doc.blankPages);
	assert.deepEqual(documentPageOrder(loaded, 2), documentPageOrder(doc, 2));
	assert.deepEqual([...loaded.pages], [...doc.pages]);
});

test("undo and redo annotation edits and insertion retain the correct page", () => {
	const doc = createEmptyDocument(pdf.path);
	const history = new History();
	const blank = insert(doc, history, 1);
	history.execute(doc, new AddCommand(blank, ink));
	history.execute(doc, new RemoveCommand(blank, ink));
	assert.equal(parseDocument(serializeDocument(doc, pdf, app), pdf.path).blankPages.length, 1);
	history.undo(doc); // Restore erased stroke.
	history.undo(doc); // Undo drawing.
	history.undo(doc); // Undo paper insertion.
	assert.deepEqual(documentPageOrder(doc, 2), [1, 2]);
	assert.equal(doc.pages.has(blank), false);
	history.redo(doc);
	history.redo(doc);
	assert.deepEqual(documentPageOrder(doc, 2), [1, blank, 2]);
	assert.deepEqual(doc.pages.get(blank).items, [ink]);
});

test("legacy notes load unchanged and invalid blank metadata is ignored", () => {
	const block = payload => '```pdf-annotations\n' + JSON.stringify(payload) + '\n```\n';
	const legacy = parseDocument('---\nversion: 1\n---\n' + block({ page: 2, items: [ink] }), pdf.path);
	assert.deepEqual(legacy.blankPages, []);
	assert.deepEqual(legacy.pages.get(2).items, [ink]);
	for (const metadata of [undefined, { afterPage: 0, width: 1, height: 1 },
		{ afterPage: 1, width: -2, height: 1 }, { afterPage: 1, width: 1, height: "792" }]) {
		const parsed = parseDocument(block({ page: -1, blankPage: metadata, items: [ink] }), pdf.path);
		assert.deepEqual(parsed.blankPages, []);
		assert.equal(parsed.pages.size, 0);
	}
});

class ElementFixture extends EventTarget {
	children = [];
	style = {};
	attributes = {};
	classList = { add() {}, remove() {}, toggle() {} };
	setAttribute(key, value) { this.attributes[key] = value; }
	appendChild(child) { return this.insertBefore(child, null); }
	insertBefore(child, before) {
		child.remove();
		const index = before ? this.children.indexOf(before) : this.children.length;
		this.children.splice(index, 0, child);
		child.parent = this;
		return child;
	}
	append(...children) { children.forEach(child => this.appendChild(child)); }
	remove() {
		if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
		this.parent = null;
	}
	replaceChildren(...children) {
		for (const child of [...this.children]) child.remove();
		this.append(...children);
	}
	createDiv() { return this.appendChild(new ElementFixture()); }
	createEl() { return this.appendChild(new ElementFixture()); }
}

test("view renders blank overlays, scales them, navigates in display order, and preserves PDF elements", async () => {
	const oldDocument = globalThis.document;
	globalThis.document = { createElementNS: () => new ElementFixture() };
	try {
		const doc = createEmptyDocument(pdf.path);
		const history = new History();
		const blank = insert(doc, history, 1, 800, 600);
		addAnnotation(doc, blank, ink);
		const scroll = new ElementFixture();
		const originalPages = [1, 2].map(page => ({ page, container: scroll.createDiv() }));
		const view = Object.create(PDFAnnotatorView.prototype);
		Object.assign(view, {
			annDoc: doc, pdfDoc: { numPages: 2 }, scrollEl: scroll, pageEls: [...originalPages],
			zoom: 1.5, activeTool: { id: "pen" }, intersectionObserver: null,
		});
		view.syncBlankPages();
		assert.deepEqual(view.pageEls.map(p => p.page), [1, blank, 2]);
		const paper = view.pageEls[1];
		assert.equal(paper.container.style.width, "1200px");
		assert.equal(paper.overlay.svg.attributes.viewBox, "0 0 800 600");
		assert.equal(paper.overlay.itemsLayer.children.length, 1);
		assert.equal(paper.overlay.page, blank);
		view.zoom = 2;
		await view.renderPdfPage(blank);
		assert.equal(paper.overlay.svg.style.height, "1200px");
		let destination;
		view.pageNavigation = { stop() {}, jumpToPage(page) { destination = page; } };
		view.jumpToPage(blank);
		assert.equal(destination, 2);
		view.jumpToPage(2);
		assert.equal(destination, 3);
		history.undo(doc);
		view.syncBlankPages();
		assert.deepEqual(view.pageEls, originalPages);
		assert.equal(paper.container.parent, null);
		history.redo(doc);
		view.syncBlankPages();
		assert.equal(view.pageEls[2], originalPages[1]);
		assert.deepEqual(scroll.children, view.pageEls.map(p => p.container));
	} finally {
		globalThis.document = oldDocument;
	}
});

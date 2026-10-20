import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const { outputFiles } = await build({
	stdin: { contents: `
		export * from "./src/search";
		export * from "./src/search-bar";
		export * from "./src/annotations/model";
		export * from "./src/history";
	`, resolveDir: process.cwd() },
	bundle: true, write: false, format: "esm",
});
const { DocumentSearch, SearchBar, textMatches, searchPdfText, createEmptyDocument, addAnnotation, History, UpdateCommand } =
	await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);

const content = (...items) => ({ items: items.map(item => typeof item === "string" ? { str: item, hasEOL: false } : item), styles: {} });
const note = (id, text) => ({ id, type: "text", text, x: 10, y: 20, w: 100, h: 40, fontSize: 14, color: "#000000" });
const deferred = () => {
	let resolve;
	const promise = new Promise(r => { resolve = r; });
	return { promise, resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

test("literal case-insensitive search handles Unicode, punctuation, repeated matches and flexible whitespace", () => {
	assert.deepEqual(textMatches("ÜBUNG [a+b]? übung", "übung").map(m => [m.start, m.end]), [[0, 5], [13, 18]]);
	assert.equal(textMatches("[a+b]? aab", "[a+b]?").length, 1);
	assert.equal(textMatches("line\n \tbreak", "line break").length, 1);
	assert.equal(textMatches("banana", "an").length, 2);
	assert.deepEqual(textMatches("anything", " \t"), []);
});

test("PDF matches span text runs and line breaks with correct textDiv offsets", () => {
	const matches = searchPdfText(content(
		{ type: "beginMarkedContent" }, "The ", "search", { str: "able", hasEOL: true },
		{ str: "", hasEOL: false }, "PDF", { type: "endMarkedContent" },
	), 3, "searchable PDF");
	assert.equal(matches.length, 1);
	assert.deepEqual(matches[0].segments, [
		{ item: 1, start: 0, end: 6 }, { item: 2, start: 0, end: 4 },
		{ item: 4, start: 0, end: 3 },
	]);
	assert.equal(matches[0].page, 3);
});

test("search covers unrendered PDF pages and notes in viewer order, with scope filters and cached extraction", async () => {
	const reads = [];
	const engine = new DocumentSearch({ numPages: 2, async getPage(page) {
		reads.push(page);
		return { getTextContent: async () => content(`needle on page ${page}`) };
	} });
	const doc = createEmptyDocument("sample.pdf");
	doc.blankPages.push({ page: -1, afterPage: 1, width: 300, height: 400 });
	addAnnotation(doc, 1, note("one", "needle in note"));
	addAnnotation(doc, -1, note("blank", "needle on blank paper"));
	addAnnotation(doc, 2, { id: "math", type: "latex", source: "needle" });
	addAnnotation(doc, 2, { id: "quote", type: "text-highlight", text: "needle", rects: [] });
	addAnnotation(doc, 2, { id: "ink", type: "ink", points: [] });
	const all = await engine.search(doc, "NEEDLE", "all", () => true);
	assert.deepEqual(all.matches.map(m => [m.page, m.kind]), [
		[1, "pdf"], [1, "note"], [-1, "note"], [2, "pdf"], [2, "note"], [2, "note"],
	]);
	assert.equal((await engine.search(doc, "needle", "notes", () => true)).matches.length, 4);
	assert.equal((await engine.search(doc, "needle", "pdf", () => true)).matches.length, 2);
	assert.deepEqual(reads, [1, 2]);
	engine.destroy();
});

test("note edits and undo are searched from the current model without saving or re-extracting the PDF", async () => {
	const engine = new DocumentSearch({ numPages: 1, getPage() { assert.fail("Notes-only search must not read PDF text"); } });
	const doc = createEmptyDocument("sample.pdf");
	const original = note("note", "before");
	addAnnotation(doc, 1, original);
	const history = new History();
	history.execute(doc, new UpdateCommand(1, original, { ...original, text: "after" }));
	assert.equal((await engine.search(doc, "after", "notes", () => true)).matches.length, 1);
	history.undo(doc);
	assert.equal((await engine.search(doc, "after", "notes", () => true)).matches.length, 0);
	assert.equal((await engine.search(doc, "before", "notes", () => true)).matches.length, 1);
});

test("failed PDF extraction preserves note results and is retried on subsequent queries", async () => {
	let fail = true;
	const engine = new DocumentSearch({ numPages: 2, async getPage(page) {
		if (page === 1 && fail) throw new Error("Unreadable page");
		return { getTextContent: async () => content("needle") };
	} });
	const doc = createEmptyDocument("sample.pdf");
	addAnnotation(doc, 1, note("one", "needle"));
	let result = await engine.search(doc, "needle", "all", () => true);
	assert.equal(result.failedPages, 1);
	assert.deepEqual(result.matches.map(m => m.kind), ["note", "pdf"]);
	fail = false;
	result = await engine.search(doc, "needle", "all", () => true);
	assert.equal(result.failedPages, 0);
	assert.equal(result.matches.length, 3);
});

test("canceling or destroying a search stops extraction before subsequent pages", async () => {
	for (const destroy of [false, true]) {
		const pending = deferred();
		const reads = [];
		let current = true;
		const engine = new DocumentSearch({ numPages: 3, async getPage(page) {
			reads.push(page);
			return { getTextContent: () => pending.promise };
		} });
		const search = engine.search(createEmptyDocument("sample.pdf"), "needle", "all", () => current);
		await settle();
		if (destroy) engine.destroy();
		else current = false;
		pending.resolve(content("needle"));
		assert.deepEqual((await search).matches, []);
		assert.deepEqual(reads, [1]);
	}
});

test("search extracts real multi-page PDFs without any rendered DOM and leaves source bytes unchanged", async () => {
	const pdf = await PDFDocument.create();
	pdf.addPage().drawText("First page");
	pdf.addPage().drawText("Find this phrase");
	const bytes = await pdf.save();
	const before = bytes.slice();
	const loaded = await getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
	try {
		const engine = new DocumentSearch(loaded);
		const result = await engine.search(createEmptyDocument("sample.pdf"), "THIS phrase", "pdf", () => true);
		assert.equal(result.matches.length, 1);
		assert.equal(result.matches[0].page, 2);
		assert.ok(result.matches[0].segments.length);
		assert.deepEqual(bytes, before);
		engine.destroy();
	} finally {
		await loaded.destroy();
	}
});

class Element extends EventTarget {
	constructor(doc, tag = "div") {
		super();
		this.ownerDocument = doc;
		this.tagName = tag;
		this.children = [];
		this.value = "";
	}
	createEl(tag, options = {}) {
		const child = new Element(this.ownerDocument, tag);
		child.value = options.value ?? "";
		child.text = options.text ?? "";
		child.attrs = options.attr ?? {};
		this.children.push(child);
		child.parent = this;
		return child;
	}
	createDiv(options) { return this.createEl("div", options); }
	setText(text) { this.text = text; }
	focus() { this.ownerDocument.activeElement = this; }
	select() {}
	remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
}

function barFixture(engine) {
	const timers = new Map();
	let id = 0;
	const doc = { defaultView: {
		setTimeout(callback) { timers.set(++id, callback); return id; },
		clearTimeout(id) { timers.delete(id); },
	} };
	const root = new Element(doc);
	const navigations = [];
	let focusRestored = 0;
	const bar = new SearchBar(root, engine, createEmptyDocument("sample.pdf"),
		(match, scroll) => navigations.push({ match, scroll }), () => focusRestored++);
	return {
		bar, timers, navigations, focusRestored: () => focusRestored,
		async flush() {
			for (const [key, callback] of timers) { timers.delete(key); callback(); }
			await settle();
		},
		input(query) { bar.input.value = query; bar.input.dispatchEvent(new Event("input")); },
	};
}
const match = (start, snippet = "needle") => ({ page: 1, kind: "pdf", start, end: start + 6, snippet });

test("find UI debounces typing, counts matches, wraps navigation and clears markers on close", async () => {
	const calls = [];
	const fixture = barFixture({ search: async (...args) => {
		calls.push(args);
		return { matches: [match(0), match(10)], failedPages: 0 };
	}, destroy() {} });
	const { bar } = fixture;
	bar.open();
	fixture.input("need");
	fixture.input("needle");
	assert.equal(fixture.timers.size, 1);
	await fixture.flush();
	assert.equal(calls.length, 1);
	assert.equal(bar.status.text, "1 of 2 matches");
	assert.equal(fixture.navigations.at(-1).scroll, true);
	bar.previous.dispatchEvent(new Event("click"));
	assert.equal(bar.status.text, "2 of 2 matches");
	bar.next.dispatchEvent(new Event("click"));
	assert.equal(bar.status.text, "1 of 2 matches");
	bar.close();
	assert.equal(bar.el.hidden, true);
	assert.equal(fixture.navigations.at(-1).match, null);
	assert.equal(fixture.focusRestored(), 1);
});

test("outdated, closed and destroyed searches cannot publish results or navigate", async () => {
	const requests = [];
	let destroyed = 0;
	const fixture = barFixture({ search: () => {
		const request = deferred();
		requests.push(request);
		return request.promise;
	}, destroy() { destroyed++; } });
	const { bar } = fixture;
	bar.open();
	fixture.input("old");
	await fixture.flush();
	fixture.input("new");
	await fixture.flush();
	requests[1].resolve({ matches: [match(10, "new")], failedPages: 0 });
	await settle();
	requests[0].resolve({ matches: [match(0, "old")], failedPages: 0 });
	await settle();
	assert.equal(fixture.navigations.at(-1).match.snippet, "new");
	bar.refresh();
	await fixture.flush();
	bar.close();
	requests[2].resolve({ matches: [match(0)], failedPages: 0 });
	await settle();
	assert.equal(fixture.navigations.at(-1).match, null);
	bar.open();
	await fixture.flush();
	bar.destroy();
	const count = fixture.navigations.length;
	requests[3].resolve({ matches: [match(0)], failedPages: 0 });
	await settle();
	assert.equal(fixture.navigations.length, count);
	assert.equal(destroyed, 1);
	assert.equal(fixture.timers.size, 0);
});

test("empty and unmatched queries disable navigation, and Enter/Escape stay inside search", async () => {
	const fixture = barFixture({ search: async () => ({ matches: [], failedPages: 1 }), destroy() {} });
	const { bar } = fixture;
	bar.open();
	assert.equal(bar.status.text, "Enter text to search");
	assert.equal(bar.next.disabled, true);
	fixture.input("missing");
	await fixture.flush();
	assert.equal(bar.status.text, "No matches · Could not search 1 PDF page(s)");
	assert.equal(bar.previous.disabled, true);
	const escape = new Event("keydown", { cancelable: true });
	Object.defineProperty(escape, "key", { value: "Escape" });
	bar.el.dispatchEvent(escape);
	assert.equal(escape.defaultPrevented, true);
	assert.equal(bar.el.hidden, true);
});

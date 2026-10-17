import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { PDFDocument, PDFName, degrees } from "pdf-lib";
import { getDocument, OPS, Util } from "pdfjs-dist/legacy/build/pdf.mjs";

const { outputFiles } = await build({
	stdin: {
		contents: `export * from "./src/pdf-export";
			export * from "./src/annotations/model";
			export * from "./src/view";
			export { default as PdfAnnotatorPlugin } from "./src/main";
			export { Toolbar } from "./src/toolbar";
			export { fixture, TFile } from "obsidian";`,
		resolveDir: process.cwd(),
	},
	bundle: true, write: false, format: "esm",
	plugins: [{
		name: "obsidian-fixture",
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
			build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
				export const fixture = { notices: [] };
				export class FileView {}
				export class Scope {}
				export class TFile {}
				export class TFolder {}
				export class Notice {
					constructor(message) { this.message = message; fixture.notices.push(this); }
					setMessage(message) { this.message = message; }
					hide() { this.hidden = true; }
				}
				export class Plugin {}
				export class PluginSettingTab {}
				export class Setting {}
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
	exportAnnotatedPdf, annotatedPdfPath, createEmptyDocument, addAnnotation,
	PDFAnnotatorView, PdfAnnotatorPlugin, Toolbar, TFile, fixture,
} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text + "\n//# sourceURL=pdf-export-fixture.mjs").toString("base64")}`);

const ink = (id = "ink") => ({ id, type: "ink", color: "#e03131", width: 3, opacity: 1, points: [[10, 20], [70, 80]] });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", "base64");

async function sourcePdf(rotations = [0, 0]) {
	const pdf = await PDFDocument.create();
	pdf.setTitle("Original metadata");
	for (const [index, rotation] of rotations.entries()) {
		const page = pdf.addPage([300, 400]);
		page.drawText(`Original page ${index + 1}`, { x: 40, y: 200, size: 12 });
		page.setCropBox(20, 30, 200, 300);
		page.setRotation(degrees(rotation));
	}
	// Existing PDF annotations should survive as well as the source content.
	const note = pdf.context.register(pdf.context.obj({ Type: "Annot", Subtype: "Text", Rect: [40, 40, 60, 60], Contents: "Native note" }));
	pdf.getPage(0).node.set(PDFName.of("Annots"), pdf.context.obj([note]));
	const bytes = await pdf.save();
	const js = await getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
	const viewports = new Map();
	for (let n = 1; n <= rotations.length; n++) viewports.set(n, (await js.getPage(n)).getViewport({ scale: 1 }));
	await js.destroy();
	return { bytes, viewports };
}

async function readPdf(bytes) {
	return getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
}

test("export retains searchable source pages, metadata, native annotations, and empty/annotated blank pages", async () => {
	const { bytes, viewports } = await sourcePdf();
	const original = bytes.slice();
	const doc = createEmptyDocument("Folder/Source.pdf");
	doc.blankPages = [
		{ page: -2, afterPage: 1, width: 200, height: 300 },
		{ page: -1, afterPage: 1, width: 500, height: 250 },
		{ page: -3, afterPage: 2, width: 100, height: 150 },
	];
	addAnnotation(doc, 1, ink());
	addAnnotation(doc, -1, { id: "shape", type: "shape", shape: "rect", x: 10, y: 20, x2: 60, y2: 50, color: "#000", width: 2, opacity: 1 });
	const before = structuredClone(doc), progress = [];
	const result = await exportAnnotatedPdf(bytes, doc, { viewports, rasterize: () => assert.fail("No raster content"), onProgress: (...p) => progress.push(p) });
	assert.deepEqual(bytes, original);
	assert.deepEqual(doc, before);
	assert.deepEqual(progress, [[0, 5], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
	const pdf = await PDFDocument.load(result);
	assert.equal(pdf.getTitle(), "Original metadata");
	assert.deepEqual(pdf.getPages().map(p => p.getSize()), [
		{ width: 300, height: 400 }, { width: 200, height: 300 }, { width: 500, height: 250 },
		{ width: 300, height: 400 }, { width: 100, height: 150 },
	]);
	assert.equal(pdf.getPage(0).node.Annots().size(), 1);
	const js = await readPdf(result);
	try {
		const text = [];
		for (let n = 1; n <= js.numPages; n++) text.push((await (await js.getPage(n)).getTextContent()).items.map(i => i.str).join(""));
		assert.deepEqual(text, ["Original page 1", "", "", "Original page 2", ""]);
	} finally { await js.destroy(); }
});

test("strokes stay aligned to viewport coordinates on cropped pages at all rotations", async () => {
	const { bytes, viewports } = await sourcePdf([0, 90, 180, 270]);
	const doc = createEmptyDocument("Source.pdf");
	for (let n = 1; n <= 4; n++) addAnnotation(doc, n, ink());
	const result = await exportAnnotatedPdf(bytes, doc, { viewports, rasterize: () => assert.fail() });
	const js = await readPdf(result);
	try {
		for (let n = 1; n <= 4; n++) {
			const page = await js.getPage(n), ops = await page.getOperatorList();
			let matrix = [1, 0, 0, 1, 0, 0];
			const stack = [], starts = [];
			for (const [i, op] of ops.fnArray.entries()) {
				const args = ops.argsArray[i];
				if (op === OPS.save) stack.push([...matrix]);
				else if (op === OPS.restore) matrix = stack.pop();
				else if (op === OPS.transform) matrix = Util.transform(matrix, args);
				else if (op === OPS.constructPath && args[0][0] === OPS.moveTo) {
					starts.push(Util.applyTransform(Util.applyTransform(args[1].slice(0, 2), matrix), page.getViewport({ scale: 1 }).transform));
				}
			}
			assert.ok(starts.some(([x, y]) => Math.abs(x - 10) < 0.001 && Math.abs(y - 20) < 0.001), `Stroke at the wrong position for rotation ${page.rotate}: ${JSON.stringify(starts)}`);
			assert.deepEqual(page.view, [20, 30, 220, 330]);
		}
	} finally { await js.destroy(); }
});

test("all annotation types export in stacking order with multiply highlights and transparent strokes", async () => {
	const { bytes, viewports } = await sourcePdf([0]);
	const doc = createEmptyDocument("Source.pdf"), rasterized = [];
	const items = [ink(), { ...ink("highlighter"), opacity: 0.4 },
		{ id: "selection", type: "text-highlight", color: "#ff0", text: "original", rects: [{ x: 30, y: 50, w: 50, h: 10 }] },
		...["rect", "ellipse", "line", "arrow"].map(shape => ({ id: shape, type: "shape", shape, x: 50, y: 60, x2: 90, y2: 100, color: "#1971c2", width: 2, opacity: 0.7 })),
		...["text", "image", "latex", "tikz", "excalidraw"].map(type => ({ id: type, type, x: 10, y: 20, w: 40, h: 30, text: "Unicode: ∑ 你好", color: "#000", fontSize: 12, src: "Image.png", source: "x^2" })),
	];
	for (const ann of items) addAnnotation(doc, 1, ann);
	const result = await exportAnnotatedPdf(bytes, doc, { viewports, rasterize: async ann => { rasterized.push(ann.id); return png; } });
	assert.deepEqual(rasterized, ["text", "image", "latex", "tikz", "excalidraw"]);
	const pdf = await PDFDocument.load(result);
	const states = pdf.getPage(0).node.Resources().lookup(PDFName.of("ExtGState"));
	const values = states.values().map(ref => pdf.context.lookup(ref).toString());
	assert.ok(values.some(s => s.includes("/BM /Multiply") && s.includes("/CA 0.4")));
	assert.ok(values.some(s => s.includes("/BM /Multiply") && s.includes("/ca 0.4")));
	const js = await readPdf(result);
	try {
		const ops = await (await js.getPage(1)).getOperatorList();
		assert.equal(ops.fnArray.filter(op => op === OPS.paintImageXObject).length, 5);
	} finally { await js.destroy(); }
});

test("export fails clearly instead of silently omitting failed content and honors cancellation", async () => {
	const { bytes, viewports } = await sourcePdf([0]);
	const doc = createEmptyDocument("Source.pdf");
	addAnnotation(doc, 1, { id: "img", type: "image", x: 0, y: 0, w: 20, h: 20, src: "Missing.png" });
	await assert.rejects(exportAnnotatedPdf(bytes, doc, { viewports, rasterize: async () => { throw new Error("Image not found"); } }), /image annotation on page 1: Image not found/);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(exportAnnotatedPdf(bytes, doc, { viewports, rasterize: () => assert.fail(), signal: controller.signal }), { name: "AbortError" });
	const during = new AbortController();
	await assert.rejects(exportAnnotatedPdf(bytes, doc, { viewports, signal: during.signal, rasterize: async () => { during.abort(); return png; } }), { name: "AbortError" });
});

test("export filenames are siblings and never replace source PDFs or previous exports", () => {
	assert.equal(annotatedPdfPath("Root.pdf", () => false), "Root.annotated.pdf");
	const existing = new Set(["Folder/Paper.PDF", "Folder/Paper.annotated.pdf", "Folder/Paper.annotated 1.pdf"]);
	assert.equal(annotatedPdfPath("Folder/Paper.PDF", p => existing.has(p)), "Folder/Paper.annotated 2.pdf");
});

function viewFixture(bytes, viewports) {
	fixture.notices.length = 0;
	const file = Object.assign(new TFile(), { path: "Folder/Source.pdf" });
	const view = Object.create(PDFAnnotatorView.prototype), writes = [];
	Object.assign(view, {
		file, noteFile: { path: "Notes/Source.md" }, annDoc: createEmptyDocument(file.path), exportController: null,
		pdfDoc: { numPages: viewports.size, getPage: async n => ({ getViewport: () => viewports.get(n) }) },
		store: { saveNow: async () => {} },
		contentEl: { ownerDocument: {} },
		toolbar: { setExportEnabled(value) { this.enabled = value; } },
		deactivateTools() {},
		app: { vault: {
			readBinary: async () => bytes,
			getAbstractFileByPath: p => p === "Folder/Source.annotated.pdf" ? {} : null,
			createBinary: async (path, data) => { writes.push({ path, data }); },
		} },
	});
	return { view, writes };
}

test("view commits edits, snapshots annotations, blocks duplicate export, and restores toolbar state", async () => {
	const { bytes, viewports } = await sourcePdf([0]);
	const { view, writes } = viewFixture(bytes, viewports);
	let release;
	view.app.vault.readBinary = () => new Promise(resolve => { release = () => resolve(bytes); });
	view.deactivateTools = () => addAnnotation(view.annDoc, 1, ink());
	const exporting = view.exportPdf();
	assert.equal(view.canExportPdf(), false);
	assert.equal(view.toolbar.enabled, false);
	await view.exportPdf();
	while (!release) await Promise.resolve();
	view.annDoc.pages.get(1).items[0].points[0] = [999, 999];
	release();
	await exporting;
	assert.equal(writes.length, 1);
	assert.equal(writes[0].path, "Folder/Source.annotated 1.pdf");
	assert.ok(writes[0].data instanceof ArrayBuffer);
	assert.equal(view.canExportPdf(), true);
	assert.equal(view.toolbar.enabled, true);
	assert.equal(fixture.notices[0].hidden, true);
	const js = await readPdf(new Uint8Array(writes[0].data));
	try {
		const ops = await (await js.getPage(1)).getOperatorList();
		const path = ops.argsArray.find((args, i) => ops.fnArray[i] === OPS.constructPath && args[0][0] === OPS.moveTo);
		assert.deepEqual(path[1].slice(0, 2), [10, 20]);
	} finally { await js.destroy(); }
});

test("view cancellation during loading writes no output and clears its progress notice", async () => {
	const { bytes, viewports } = await sourcePdf([0]);
	const { view, writes } = viewFixture(bytes, viewports);
	let release;
	view.app.vault.readBinary = () => new Promise(resolve => { release = () => resolve(bytes); });
	const exporting = view.exportPdf();
	while (!release) await Promise.resolve();
	view.exportController.abort(); release();
	await exporting;
	assert.equal(writes.length, 0);
	assert.equal(view.exportController, null);
	assert.equal(fixture.notices.length, 1);
	assert.equal(fixture.notices[0].hidden, true);
});

test("the command is available only for a ready annotator and the toolbar invokes export", async () => {
	const commands = [], plugin = Object.create(PdfAnnotatorPlugin.prototype);
	let ready = false, exports = 0;
	const view = { canExportPdf: () => ready, exportPdf: () => { exports++; } };
	Object.assign(plugin, {
		loadSettings: async () => {}, registerView() {}, addSettingTab() {}, registerEvent() {},
		addCommand: cmd => commands.push(cmd), app: { workspace: { getActiveViewOfType: () => view, on() {} } },
	});
	await plugin.onload();
	const command = commands.find(c => c.id === "export-annotated-pdf");
	assert.equal(command.checkCallback(true), false);
	ready = true;
	assert.equal(command.checkCallback(true), true);
	assert.equal(exports, 0);
	command.checkCallback(false);
	assert.equal(exports, 1);
	class Element extends EventTarget {
		children = []; style = {}; classList = { toggle() {} };
		createEl(tag, options = {}) { const child = new Element(); child.options = options; this.children.push(child); return child; }
		createDiv(options) { return this.createEl("div", options); }
		getAttribute(name) { return this.options?.attr?.[name]; }
	}
	const parent = new Element();
	const toolbar = new Toolbar(parent, {}, { onExportPdf: () => { exports++; } }, "pen");
	const button = toolbar.el.children.find(el => el.options?.attr?.title === "Export annotated PDF");
	assert.equal(button.disabled, true);
	toolbar.setExportEnabled(true);
	assert.equal(button.disabled, false);
	button.dispatchEvent(new Event("click"));
	assert.equal(exports, 2);
});

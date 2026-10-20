import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
	entryPoints: ["src/view.ts"], bundle: true, write: false, format: "esm",
	plugins: [{
		name: "obsidian-fixture",
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
			build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
				export class FileView {} export class Scope {} export class TFile {}
				export class TFolder {} export class Notice {} export class Menu {}
				export class Modal {} export class FuzzySuggestModal {} export class Component {}
				export class MarkdownRenderer {}
				export const loadMathJax = async () => {}; export const finishRenderMath = async () => {};
				export const renderMath = () => {}; export const normalizePath = path => path;
				export const setIcon = () => {}; export const loadPdfJs = async () => {};
			` }));
		},
	}],
});
const { PDFAnnotatorView } = await import(
	`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

function viewer() {
	const viewport = { left: 40, top: 130, right: 430, bottom: 730 };
	const scroll = { clientWidth: 390, clientHeight: 600, scrollLeft: 80, scrollTop: 800, getBoundingClientRect: () => viewport };
	let refreshes = 0;
	const view = Object.create(PDFAnnotatorView.prototype);
	Object.assign(view, {
		zoom: 1, pageEls: [], scrollEl: scroll, queuedPages: new Set(), renderQueue: Promise.resolve(),
		toolCtx: {}, selectTool: { refresh() { refreshes++; } }, touchNavigation: { isZooming: true },
	});
	const sizes = [[1, 612, 792], [-1, 800, 300], [2, 400, 900], [3, 612, 792], [4, 600, 900]];
	view.pageEls = sizes.map(([page, pdfWidth, pdfHeight], index) => ({
		page, pdfWidth, pdfHeight, rendered: true, renderedZoom: 1,
		canvas: { style: {} }, textLayer: { style: {} },
		container: {
			style: { width: `${pdfWidth}px`, height: `${pdfHeight}px` },
			getBoundingClientRect() {
				const width = parseFloat(this.style.width), height = parseFloat(this.style.height);
				const left = viewport.left + Math.max(0, (scroll.clientWidth - width) / 2) - scroll.scrollLeft;
				const top = viewport.top + 16 + view.pageEls.slice(0, index).reduce((sum, p) => sum + parseFloat(p.container.style.height) + 16, 0) - scroll.scrollTop;
				return { left, top, width, height, right: left + width, bottom: top + height };
			},
		},
	}));
	return { view, scroll, viewport, refreshes: () => refreshes };
}

function pointOnPage(page, point) {
	const rect = page.container.getBoundingClientRect();
	return { x: (point.clientX - rect.left) / rect.width, y: (point.clientY - rect.top) / rect.height };
}

function assertSamePoint(actual, expected) {
	assert.ok(Math.abs(actual.x - expected.x) < 1e-9);
	assert.ok(Math.abs(actual.y - expected.y) < 1e-9);
}

test("pinch zoom preserves its moving anchor across mixed PDF and blank page sizes and fixed gaps", () => {
	const { view } = viewer();
	const queued = [];
	view.enqueueRender = page => { queued.push(page); view.pageEls.find(p => p.page === page).rendered = true; };
	const blank = view.pageEls[1];
	const start = { clientX: 200, clientY: 300 }, end = { clientX: 220, clientY: 330 };
	const point = pointOnPage(blank, start);
	view.transformTouch(start, end, 1.4);
	assert.equal(view.zoom, 1.4);
	assertSamePoint(pointOnPage(blank, end), point);
	assert.equal(view.pageEls[0].textLayer.style.scale, "1.4");
	assert.equal(blank.canvas.style.width, "1120px");
	assert.deepEqual(queued, [], "gesture frames stretch existing canvases without starting PDF renders");
	const beforePan = pointOnPage(blank, end);
	const panEnd = { clientX: 180, clientY: 290 };
	view.transformTouch(end, panEnd, 1);
	assertSamePoint(pointOnPage(blank, panEnd), beforePan);
});

test("zoom clamps to supported limits and refreshes nearby PDF pages once on release", () => {
	const { view, refreshes } = viewer();
	const queued = [];
	view.enqueueRender = page => { queued.push(page); view.pageEls.find(p => p.page === page).rendered = true; };
	const center = { clientX: 230, clientY: 300 };
	view.transformTouch(center, center, 100);
	assert.equal(view.zoom, 4);
	view.transformTouch(center, center, 0.00001);
	assert.equal(view.zoom, 0.25);
	view.transformTouch(center, center, 4);
	assert.equal(view.zoom, 1);
	view.transformTouch(center, center, 1.5);
	view.touchNavigation.isZooming = false;
	view.finishTouchZoom();
	assert.ok(queued.length > 0);
	assert.ok(!queued.includes(-1), "blank pages have no PDF bitmap to render");
	assert.ok(!queued.includes(4), "distant PDF pages stay lazy");
	assert.equal(view.pageEls.at(-1).rendered, false);
	const count = queued.length;
	view.finishTouchZoom();
	assert.equal(queued.length, count);
	assert.equal(refreshes(), 1);
});

test("a two-finger pan without zoom resumes initial page rendering deferred by the gesture", async () => {
	const { view } = viewer();
	view.pageEls[0].rendered = false;
	view.pageEls[0].renderedZoom = undefined;
	const rendered = [];
	view.renderPdfPage = async page => { rendered.push(page); view.pageEls.find(p => p.page === page).rendered = true; };
	view.touchNavigation.isZooming = false;
	view.enqueueRender(1);
	view.touchNavigation.isZooming = true;
	await view.renderQueue;
	assert.deepEqual(rendered, []);
	view.touchNavigation.isZooming = false;
	view.finishTouchZoom();
	await view.renderQueue;
	assert.deepEqual(rendered, [1]);
});

test("toolbar zoom always steps in its requested direction after arbitrary pinch scales", () => {
	const { view } = viewer();
	for (const [zoom, smaller, larger] of [[0.25, 0.25, 0.5], [0.37, 0.25, 0.5], [1.05, 1, 1.1], [3.5, 3, 4], [4, 3, 4]]) {
		view.zoom = zoom;
		assert.equal(view.nextZoom(-1), smaller);
		assert.equal(view.nextZoom(1), larger);
	}
});

test("render requests are deferred during a pinch and duplicate requests share a queue entry", async () => {
	const { view } = viewer();
	const rendered = [];
	view.renderPdfPage = async page => rendered.push(page);
	view.enqueueRender(1);
	await view.renderQueue;
	assert.deepEqual(rendered, []);
	view.touchNavigation.isZooming = false;
	view.enqueueRender(1); view.enqueueRender(1); view.enqueueRender(1);
	await view.renderQueue;
	assert.deepEqual(rendered, [1]);
	view.enqueueRender(2);
	view.touchNavigation.isZooming = true;
	await view.renderQueue;
	assert.deepEqual(rendered, [1], "a pinch also defers PDF work queued before it started");
	view.touchNavigation.isZooming = false;
	view.enqueueRender(2);
	await view.renderQueue;
	assert.deepEqual(rendered, [1, 2]);
});

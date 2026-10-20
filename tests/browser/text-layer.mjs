import { renderPage } from "../../src/pdf-renderer";
import { searchPdfText } from "../../src/search";
import { PDFAnnotatorView } from "../../src/view";
import { TextHighlightTool } from "../../src/tools/text-highlight";
import { PageOverlay } from "../../src/overlay";
import { createEmptyDocument } from "../../src/annotations/model";
import { History } from "../../src/history";

function assert(value, message) { if (!value) throw new Error(message); }
function near(actual, expected, message, tolerance = 1.5) {
	assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
}

// The plugin normally receives these DOM helpers from Obsidian.
HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.createDiv = function (options = {}) {
	const el = this.ownerDocument.createElement("div");
	el.className = options.cls ?? "";
	for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
	this.appendChild(el);
	return el;
};

function inkBounds(canvas) {
	const { data, width, height } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
	let left = width, top = height, right = 0, bottom = 0;
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const i = (y * width + x) * 4;
		if (data[i + 3] > 128 && data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) {
			left = Math.min(left, x); right = Math.max(right, x + 1);
			top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
		}
	}
	const rect = canvas.getBoundingClientRect();
	return {
		left: rect.left + left * rect.width / width, top: rect.top + top * rect.height / height,
		right: rect.left + right * rect.width / width, bottom: rect.top + bottom * rect.height / height,
	};
}

export async function run(options) {
	await new Promise(resolve => {
		if (document.readyState === "complete") resolve();
		else window.addEventListener("load", resolve, { once: true });
	});
	const pdfjs = await import(options.runtime);
	globalThis.activeWindow = window;
	globalThis.activeDocument = document;
	globalThis.testPdfJs = pdfjs;
	pdfjs.GlobalWorkerOptions.workerSrc = options.worker;
	const pdf = await pdfjs.getDocument({ data: await (await fetch(options.pdf)).arrayBuffer(), useSystemFonts: true }).promise;
	let cases = 0;
	let pointerProbe;
	try {
		for (let number = 1; number <= pdf.numPages; number++) for (const zoom of [0.67, 1, 1.75]) {
			const label = `page ${number}, zoom ${zoom}`;
			document.body.replaceChildren();
			const container = document.body.createDiv({ cls: "pdf-annotator-page mode-text-select" });
			const canvas = document.createElement("canvas");
			container.appendChild(canvas);
			const textLayer = container.createDiv({ cls: "pdf-annotator-textlayer" });
			const info = await renderPage(pdf, number, canvas, textLayer, zoom);
			const overlay = new PageOverlay(container, number, info.pdfWidth, info.pdfHeight);
			overlay.svg.classList.add("tool-select");
			const page = {
				page: number, container, canvas, textLayer, overlay,
				...info, renderedZoom: zoom, rendered: true,
			};
			const view = Object.create(PDFAnnotatorView.prototype);
			Object.assign(view, {
				zoom, pageEls: [page], searchMarks: [], searchScrollPending: false,
				annDoc: createEmptyDocument("fixture.pdf"),
			});
			view.applyPageSize(page);
			const pdfPage = await pdf.getPage(number);
			const content = await pdfPage.getTextContent();
			const match = searchPdfText(content, number, "rekursiv definiert durch")[0];
			assert(match && match.segments.length === 1, `${label}: searchable text`);
			const segment = match.segments[0];
			const span = info.textDivs[segment.item];
			const range = document.createRange();
			range.setStart(span.firstChild, segment.start);
			range.setEnd(span.firstChild, segment.end);
			const selection = document.getSelection();
			selection.removeAllRanges();
			selection.addRange(range);
			assert(selection.toString() === "rekursiv definiert durch", `${label}: native text selection`);
			assert(getComputedStyle(span).userSelect === "text", `${label}: selectable text`);

			// Compare DOM geometry with actual raster ink, not another copy of the CSS.
			const rect = range.getBoundingClientRect(), ink = inkBounds(canvas);
			assert(rect.left <= ink.left + 2 && rect.right >= ink.right - 2 &&
				rect.top <= ink.top + 2 && rect.bottom >= ink.bottom - 2, `${label}: selection must cover the visible glyphs`);
			const horizontal = pdfPage.rotate % 180 === 0;
			near(horizontal ? rect.width : rect.height,
				content.items.filter(item => "str" in item)[segment.item].width * info.pdfWidth /
				(pdfPage.rotate % 180 ? pdfPage.view[3] - pdfPage.view[1] : pdfPage.view[2] - pdfPage.view[0]) * zoom,
				`${label}: text advance`, 2);
			const point = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
			assert(document.elementFromPoint(point.x, point.y)?.closest(".pdf-annotator-textlayer") === textLayer,
				`${label}: pointer reaches PDF text through the annotation overlay`);

			view.searchMatch = match;
			view.drawSearchMatch();
			const mark = view.searchMarks[0].getBoundingClientRect();
			for (const key of ["left", "top", "width", "height"]) near(mark[key], rect[key], `${label}: search ${key}`);

			const history = new History();
			const tool = new TextHighlightTool();
			tool.resolveOverlay = layer => layer === textLayer ? overlay : null;
			const ctx = {
				doc: view.annDoc, history, options: { highlighterColor: "#ff0" },
				getPageContainer: () => container, getPageOrder: () => [number],
				requestSave() {},
			};
			tool.onActivate(ctx);
			tool.captureSelection();
			tool.onDeactivate();
			const ann = view.annDoc.pages.get(number)?.items[0];
			assert(ann?.text === "rekursiv definiert durch", `${label}: highlight text`);
			assert(ann.rects.length === 1, `${label}: one highlight rectangle`);
			overlay.renderItems([ann]);
			const highlight = overlay.itemsLayer.querySelector("rect").getBoundingClientRect();
			for (const key of ["left", "top", "width", "height"]) near(highlight[key], rect[key], `${label}: saved highlight ${key}`);
			assert(history.undo(view.annDoc) && !view.annDoc.pages.size, `${label}: undo highlight`);

			// A pinch stretches existing content before the new bitmap is ready.
			view.zoom = zoom * 1.4;
			view.applyPageSize(page);
			const scaled = range.getBoundingClientRect(), scaledInk = inkBounds(canvas);
			assert(scaled.left <= scaledInk.left + 2 && scaled.right >= scaledInk.right - 2 &&
				scaled.top <= scaledInk.top + 2 && scaled.bottom >= scaledInk.bottom - 2, `${label}: pinch preserves rotation/alignment`);
			view.drawSearchMatch();
			const scaledMark = view.searchMarks[0].getBoundingClientRect();
			for (const key of ["left", "top", "width", "height"]) near(scaledMark[key], scaled[key], `${label}: scaled search ${key}`);
			if (number === 1 && zoom === 1) pointerProbe = { view, page, ctx, tool };
			else overlay.destroy();
			cases++;
		}
		const { view, page, ctx, tool } = pointerProbe;
		document.body.replaceChildren(page.container);
		view.zoom = 1;
		view.applyPageSize(page);
		page.overlay.renderItems([]);
		view.searchMatch = null;
		view.drawSearchMatch();
		const range = document.createRange();
		range.selectNodeContents(page.textDivs.find(span => span.textContent.includes("rekursiv")));
		const rect = range.getBoundingClientRect();
		document.getSelection().removeAllRanges();
		globalThis.startHighlightProbe = () => {
			document.getSelection().removeAllRanges();
			tool.onActivate(ctx);
		};
		globalThis.finishHighlightProbe = async () => {
			await new Promise(resolve => setTimeout(resolve, 30));
			tool.onDeactivate();
			return view.annDoc.pages.get(1)?.items[0]?.text;
		};
		return {
			pdfjs: pdfjs.version, cases,
			checks: "raster alignment, native selection, search, saved highlights, undo, rotations, zoom, UserUnit",
			pointer: {
				start: { x: rect.left + 0.5, y: rect.top + rect.height / 2 },
				end: { x: rect.right - 0.5, y: rect.top + rect.height / 2 },
				text: range.toString(),
			},
		};
	} finally {
		await pdf.destroy();
	}
}

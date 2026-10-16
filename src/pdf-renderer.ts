import { TFile, App, loadPdfJs } from "obsidian";
import type {
	PDFDocumentProxy,
	PDFPageProxy,
} from "pdfjs-dist/types/src/display/api";

/**
 * Thin wrapper over Obsidian's bundled pdf.js (loaded via loadPdfJs()).
 * Handles document loading, page canvas rendering and the text layer.
 */

// pdf.js module shape (subset we use) — loadPdfJs() returns `any`.
interface PdfJsModule {
	getDocument(opts: { data: ArrayBuffer }): {
		promise: Promise<PDFDocumentProxy>;
	};
	renderTextLayer?(opts: {
		textContentSource: unknown;
		container: HTMLElement;
		viewport: unknown;
		textDivs?: HTMLElement[];
	}): { promise: Promise<void> };
	TextLayer?: new (opts: {
		textContentSource: unknown;
		container: HTMLElement;
		viewport: unknown;
	}) => { render(): Promise<void> };
}

let pdfjsPromise: Promise<PdfJsModule> | null = null;

export function getPdfJs(): Promise<PdfJsModule> {
	if (!pdfjsPromise) {
		pdfjsPromise = loadPdfJs() as Promise<PdfJsModule>;
	}
	return pdfjsPromise;
}

export async function loadPdfDocument(
	app: App,
	file: TFile
): Promise<PDFDocumentProxy> {
	const pdfjs = await getPdfJs();
	const data = await app.vault.readBinary(file);
	return await pdfjs.getDocument({ data }).promise;
}

export interface RenderedPage {
	/** PDF page width in user-space units. */
	pdfWidth: number;
	/** PDF page height in user-space units. */
	pdfHeight: number;
}

/** Get a page's unscaled size in PDF units. */
export async function getPageSize(
	pdfDoc: PDFDocumentProxy,
	pageNum: number
): Promise<{ width: number; height: number }> {
	const page = await pdfDoc.getPage(pageNum);
	const vp = page.getViewport({ scale: 1 });
	return { width: vp.width, height: vp.height };
}

/**
 * Render a PDF page onto a canvas at the given zoom, and (re)build the
 * text layer in the provided container.
 */
export async function renderPage(
	pdfDoc: PDFDocumentProxy,
	pageNum: number,
	canvas: HTMLCanvasElement,
	textLayerEl: HTMLElement,
	zoom: number
): Promise<RenderedPage> {
	const page: PDFPageProxy = await pdfDoc.getPage(pageNum);
	const baseViewport = page.getViewport({ scale: 1 });
	const dpr = window.devicePixelRatio || 1;
	const viewport = page.getViewport({ scale: zoom });

	canvas.width = Math.floor(viewport.width * dpr);
	canvas.height = Math.floor(viewport.height * dpr);
	canvas.style.width = `${Math.floor(viewport.width)}px`;
	canvas.style.height = `${Math.floor(viewport.height)}px`;

	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Could not get canvas context");
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

	await page.render({
		canvasContext: ctx,
		viewport,
	} as Parameters<PDFPageProxy["render"]>[0]).promise;

	// --- text layer ---
	textLayerEl.empty();
	textLayerEl.style.width = `${Math.floor(viewport.width)}px`;
	textLayerEl.style.height = `${Math.floor(viewport.height)}px`;
	// pdf.js text layer CSS expects this variable for font scaling
	textLayerEl.style.setProperty("--scale-factor", String(zoom));

	try {
		const pdfjs = await getPdfJs();
		const textContent = await page.getTextContent();
		if (pdfjs.renderTextLayer) {
			// pdf.js v3-style API (what Obsidian currently bundles)
			await pdfjs.renderTextLayer({
				textContentSource: textContent,
				container: textLayerEl,
				viewport,
			}).promise;
		} else if (pdfjs.TextLayer) {
			// pdf.js v4-style API
			const tl = new pdfjs.TextLayer({
				textContentSource: textContent,
				container: textLayerEl,
				viewport,
			});
			await tl.render();
		}
	} catch (e) {
		console.warn("PDF Annotator: text layer render failed", e);
	}

	return {
		pdfWidth: baseViewport.width,
		pdfHeight: baseViewport.height,
	};
}

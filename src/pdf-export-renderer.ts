import { App, TFile } from "obsidian";
import { RichAnnotationType, TextAnnotation } from "./annotations/model";
import { renderAnnotation } from "./overlay";
import { RasterAnnotation } from "./pdf-export";
import { mountRichContent } from "./rich-content";

const SVG_NS = "http://www.w3.org/2000/svg";
const RENDER_TIMEOUT = 15000;

/** Render only annotation content, without selections, editors, or viewer zoom. */
export function createExportRasterizer(
	app: App, doc: Document, sourcePath: string, signal: AbortSignal,
): (ann: RasterAnnotation) => Promise<Uint8Array> {
	return async ann => {
		signal.throwIfAborted();
		if (![ann.w, ann.h].every(size => Number.isFinite(size) && size > 0)) {
			throw new Error("Annotation has an invalid size.");
		}
		const host = doc.createElement("div");
		host.className = "pdfann-rich-viewport";
		Object.assign(host.style, {
			position: "fixed", left: "-100000px", top: "0", pointerEvents: "none",
			width: `${ann.w}px`, height: `${ann.h}px`,
		});
		doc.body.appendChild(host);
		const canvas = doc.createElement("canvas");
		// 144 dpi, bounded for large pages/images and mobile canvas limits.
		const scale = Math.min(2, 4096 / Math.max(1, ann.w, ann.h));
		canvas.width = Math.max(1, Math.ceil(ann.w * scale));
		canvas.height = Math.max(1, Math.ceil(ann.h * scale));
		let dispose: (() => void) | undefined;
		try {
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Could not create an export canvas.");
			ctx.scale(canvas.width / ann.w, canvas.height / ann.h);
			if (ann.type === "text") {
				await drawText(ctx, host, ann);
			} else if (ann.type === "image") {
				const image = await loadImage(doc, await localImageData(app, ann.src), signal);
				ctx.drawImage(image, 0, 0, ann.w, ann.h);
			} else {
				dispose = mountRichContent(app, ann, host, sourcePath);
				const graphic = await waitForGraphic(host, ann.type, signal);
				const bounds = graphic.getBoundingClientRect();
				const hostBounds = host.getBoundingClientRect();
				if (!bounds.width || !bounds.height) throw new Error("The rendered diagram is empty.");
				const src = graphic.tagName.toLowerCase() === "svg"
					? await svgData(app, graphic as SVGSVGElement)
					: await localImageData(app, (graphic as HTMLImageElement).src);
				const image = await loadImage(doc, src, signal);
				ctx.drawImage(image, bounds.left - hostBounds.left, bounds.top - hostBounds.top, bounds.width, bounds.height);
			}
			signal.throwIfAborted();
			const png = await new Promise<Blob>((resolve, reject) => {
				canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not encode annotation image.")), "image/png");
			});
			return new Uint8Array(await png.arrayBuffer());
		} finally {
			dispose?.();
			host.remove();
			canvas.width = canvas.height = 0;
		}
	};
}

/** Use browser layout for wrapping, whitespace, and Unicode, then paint each line. */
async function drawText(ctx: CanvasRenderingContext2D, host: HTMLElement, ann: TextAnnotation): Promise<void> {
	const div = renderAnnotation(ann)!.querySelector("div")!;
	host.appendChild(div);
	const doc = host.ownerDocument;
	await doc.fonts.ready;
	const style = doc.defaultView!.getComputedStyle(div);
	ctx.font = `${ann.fontSize}px ${style.fontFamily}`;
	ctx.fillStyle = ann.color;
	ctx.direction = style.direction === "rtl" ? "rtl" : "ltr";
	const ascent = ctx.measureText("Mg").fontBoundingBoxAscent ?? ann.fontSize;
	const origin = div.getBoundingClientRect();
	const range = doc.createRange();
	let line = "", left = 0, right = 0, top = 0, offset = 0;
	const flush = () => {
		if (line) ctx.fillText(line, (ctx.direction === "rtl" ? right : left) - origin.left, top - origin.top + ascent);
		line = "";
	};
	for (const char of ann.text) {
		range.setStart(div.firstChild!, offset);
		offset += char.length;
		range.setEnd(div.firstChild!, offset);
		if (char === "\n") { flush(); continue; }
		const rect = range.getBoundingClientRect();
		if (line && Math.abs(rect.top - top) > 0.5) flush();
		if (!line) { left = rect.left; right = rect.right; top = rect.top; }
		else { left = Math.min(left, rect.left); right = Math.max(right, rect.right); }
		line += char;
	}
	flush();
}

function waitForGraphic(host: HTMLElement, type: RichAnnotationType, signal: AbortSignal): Promise<SVGSVGElement | HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			observer.disconnect();
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		};
		const abort = () => { cleanup(); reject(signal.reason); };
		const check = () => {
			const status = host.querySelector<HTMLElement>(".pdfann-rich-status");
			if (status?.textContent?.startsWith("Could not render")) {
				cleanup(); reject(new Error(status.textContent)); return;
			}
			const graphic = host.querySelector<SVGSVGElement | HTMLImageElement>(type === "excalidraw"
				? ".excalidraw-embedded-img" : type === "tikz" ? ".block-language-tikz svg" : "mjx-container svg, svg");
			if (status?.hidden && graphic) { cleanup(); resolve(graphic); }
		};
		const observer = new MutationObserver(check);
		observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(host.querySelector(".pdfann-rich-status")?.textContent || `Timed out rendering ${type}.`));
		}, RENDER_TIMEOUT);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort(); else check();
	});
}

async function localImageData(app: App, src: string): Promise<string> {
	if (/^data:image\//i.test(src)) return src;
	if (src.startsWith("blob:")) return blobData(await (await fetch(src)).blob());
	// Resolve only vault resources; exporting must never fetch remote images.
	const stripQuery = (url: string) => url.split(/[?#]/)[0];
	const file = app.vault.getAbstractFileByPath(src) ?? app.vault.getFiles().find(
		f => stripQuery(app.vault.getResourcePath(f)) === stripQuery(src),
	);
	if (!(file instanceof TFile)) throw new Error(`Image not found in the vault: ${src}`);
	const types: Record<string, string> = {
		png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
		webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp",
	};
	return blobData(new Blob([await app.vault.readBinary(file)], { type: types[file.extension.toLowerCase()] || "application/octet-stream" }));
}

function blobData(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(new Error("Could not read annotation image."));
		reader.readAsDataURL(blob);
	});
}

/** Inline styles, MathJax glyph definitions, and local embedded images. */
async function svgData(app: App, svg: SVGSVGElement): Promise<string> {
	const clone = svg.cloneNode(true) as SVGSVGElement;
	const win = svg.ownerDocument.defaultView!;
	const originals = [svg, ...Array.from(svg.querySelectorAll("*"))];
	const copies = [clone, ...Array.from(clone.querySelectorAll("*"))];
	for (const [index, original] of originals.entries()) {
		const style = win.getComputedStyle(original);
		// SVG presentation properties otherwise inherited from the Obsidian theme.
		for (const property of ["color", "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "font-family", "font-size", "font-weight", "opacity", "visibility"]) {
			(copies[index] as SVGElement).style.setProperty(property, style.getPropertyValue(property));
		}
	}
	const defs = svg.ownerDocument.createElementNS(SVG_NS, "defs");
	clone.prepend(defs);
	for (const use of Array.from(clone.querySelectorAll("use"))) {
		const href = use.getAttribute("href") || use.getAttribute("xlink:href");
		if (!href?.startsWith("#") || clone.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)) continue;
		const glyph = svg.ownerDocument.getElementById(href.slice(1));
		if (!glyph) throw new Error("A diagram's SVG glyph is unavailable.");
		defs.appendChild(glyph.cloneNode(true));
	}
	for (const image of Array.from(clone.querySelectorAll("image"))) {
		const href = image.getAttribute("href") || image.getAttribute("xlink:href");
		if (href) {
			image.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
			image.setAttribute("href", await localImageData(app, href));
		}
	}
	clone.setAttribute("xmlns", SVG_NS);
	const bounds = svg.getBoundingClientRect();
	clone.setAttribute("width", String(bounds.width));
	clone.setAttribute("height", String(bounds.height));
	return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
}

function loadImage(doc: Document, src: string, signal: AbortSignal): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = doc.createElement("img");
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			image.onload = image.onerror = null;
		};
		const abort = () => { cleanup(); image.src = ""; reject(signal.reason); };
		const timer = setTimeout(() => { cleanup(); image.src = ""; reject(new Error("Timed out loading an annotation image.")); }, RENDER_TIMEOUT);
		image.onload = () => { cleanup(); resolve(image); };
		image.onerror = () => { cleanup(); reject(new Error("Could not decode an annotation image.")); };
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort(); else image.src = src;
	});
}

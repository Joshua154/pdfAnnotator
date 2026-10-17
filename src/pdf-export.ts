import {
	BlendMode, LineCapStyle, PDFDocument, PDFPage, clip, concatTransformationMatrix,
	endPath, popGraphicsState, pushGraphicsState, rectangle, rgb, setLineJoin,
} from "pdf-lib";
import { Annotation, AnnotationDocument, ShapeAnnotation, documentPageOrder } from "./annotations/model";
import { inkPathData } from "./overlay";

/** The same scale-1 viewport PDF.js uses to position annotations in the viewer. */
export interface ExportViewport {
	width: number;
	height: number;
	transform: readonly number[];
}

export type RasterAnnotation = Extract<Annotation, { type: "text" | "image" | "latex" | "tikz" | "excalidraw" }>;

export interface PdfExportOptions {
	viewports: ReadonlyMap<number, ExportViewport>;
	rasterize(ann: RasterAnnotation): Promise<Uint8Array>;
	signal?: AbortSignal;
	onProgress?(completed: number, total: number): void;
}

/**
 * Flatten overlays onto a separate copy, keeping the original page content,
 * searchable PDF text, page boxes, rotation, and existing PDF annotations.
 */
export async function exportAnnotatedPdf(
	source: ArrayBuffer | Uint8Array, annotations: AnnotationDocument, options: PdfExportOptions,
): Promise<Uint8Array> {
	options.signal?.throwIfAborted();
	const pdf = await PDFDocument.load(source, { updateMetadata: false });
	const originals = pdf.getPages();
	const order = documentPageOrder(annotations, originals.length);
	options.onProgress?.(0, order.length);
	for (const [index, pageId] of order.entries()) {
		options.signal?.throwIfAborted();
		const blank = annotations.blankPages.find(p => p.page === pageId);
		const page = blank ? pdf.insertPage(index, [blank.width, blank.height]) : originals[pageId - 1];
		const viewport = blank
			? { width: blank.width, height: blank.height, transform: [1, 0, 0, -1, 0, blank.height] }
			: options.viewports.get(pageId);
		if (!viewport) throw new Error(`Missing page geometry for PDF page ${pageId}.`);
		const items = annotations.pages.get(pageId)?.items ?? [];
		if (items.length) {
			// Undo PDF.js's crop/rotation/user-unit transform, then use an ordinary
			// bottom-left coordinate system for pdf-lib's drawing methods.
			page.pushOperators(
				pushGraphicsState(),
				concatTransformationMatrix(...inverseViewport(viewport)),
				concatTransformationMatrix(1, 0, 0, -1, 0, viewport.height),
				rectangle(0, 0, viewport.width, viewport.height), clip(), endPath(),
			);
			for (const ann of items) {
				options.signal?.throwIfAborted();
				try {
					await drawAnnotation(pdf, page, viewport.height, ann, options.rasterize);
				} catch (error) {
					options.signal?.throwIfAborted();
					throw new Error(`Could not export ${ann.type} annotation on page ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			page.pushOperators(popGraphicsState());
		}
		options.onProgress?.(index + 1, order.length);
	}
	options.signal?.throwIfAborted();
	return pdf.save();
}

function inverseViewport(viewport: ExportViewport): [number, number, number, number, number, number] {
	const [a, b, c, d, e, f] = viewport.transform;
	const det = a * d - b * c;
	if (!Number.isFinite(det) || det === 0) throw new Error("Invalid PDF page geometry.");
	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function color(value: string) {
	const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(value);
	const hex = short ? short.slice(1).map(c => c + c).join("") : value.replace(/^#/, "");
	if (!/^[\da-f]{6}$/i.test(hex)) throw new Error(`Unsupported annotation color: ${value}`);
	const n = parseInt(hex, 16);
	return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

async function drawAnnotation(
	pdf: PDFDocument, page: PDFPage, height: number, ann: Annotation,
	rasterize: PdfExportOptions["rasterize"],
): Promise<void> {
	switch (ann.type) {
		case "ink":
			if (!ann.points.length) return;
			page.pushOperators(setLineJoin(1));
			page.drawSvgPath(inkPathData(ann.points), {
				x: 0, y: height, borderColor: color(ann.color), borderWidth: ann.width,
				borderOpacity: ann.opacity, borderLineCap: LineCapStyle.Round,
				blendMode: ann.opacity < 1 ? BlendMode.Multiply : BlendMode.Normal,
			});
			return;
		case "shape":
			drawShape(page, height, ann);
			return;
		case "text-highlight":
			for (const r of ann.rects) {
				page.drawRectangle({
					x: r.x, y: height - r.y - r.h, width: r.w, height: r.h,
					color: color(ann.color), opacity: 0.4, blendMode: BlendMode.Multiply,
				});
			}
			return;
		default: {
			// Browser-rendered text supports the vault font and Unicode. Images,
			// math, and diagrams use PNGs so no renderer is needed in PDF readers.
			const image = await pdf.embedPng(await rasterize(ann));
			page.drawImage(image, {
				x: ann.x, y: height - ann.y - ann.h, width: ann.w, height: ann.h,
			});
		}
	}
}

function drawShape(page: PDFPage, height: number, ann: ShapeAnnotation): void {
	const x = Math.min(ann.x, ann.x2), y = Math.min(ann.y, ann.y2);
	const w = Math.abs(ann.x2 - ann.x), h = Math.abs(ann.y2 - ann.y);
	if (ann.shape === "ellipse") {
		page.drawEllipse({
			x: x + w / 2, y: height - y - h / 2, xScale: w / 2, yScale: h / 2,
			borderColor: color(ann.color), borderWidth: ann.width, borderOpacity: ann.opacity,
		});
		return;
	}
	let path = ann.shape === "rect"
		? `M ${x} ${y} h ${w} v ${h} h ${-w} Z`
		: `M ${ann.x} ${ann.y} L ${ann.x2} ${ann.y2}`;
	if (ann.shape === "arrow") {
		const angle = Math.atan2(ann.y2 - ann.y, ann.x2 - ann.x);
		const len = Math.max(ann.width * 4, 8);
		const a1 = angle + Math.PI - 0.45, a2 = angle + Math.PI + 0.45;
		path += ` M ${ann.x2 + Math.cos(a1) * len} ${ann.y2 + Math.sin(a1) * len} L ${ann.x2} ${ann.y2} L ${ann.x2 + Math.cos(a2) * len} ${ann.y2 + Math.sin(a2) * len}`;
	}
	page.pushOperators(setLineJoin(ann.shape === "arrow" ? 1 : 0));
	page.drawSvgPath(path, {
		x: 0, y: height, borderColor: color(ann.color), borderWidth: ann.width,
		borderOpacity: ann.opacity,
		borderLineCap: ann.shape === "arrow" ? LineCapStyle.Round : LineCapStyle.Butt,
	});
}

/** A collision-free sibling filename; the source and previous exports stay intact. */
export function annotatedPdfPath(sourcePath: string, exists: (path: string) => boolean): string {
	const stem = sourcePath.replace(/\.pdf$/i, "");
	let suffix = 0;
	let path: string;
	do {
		path = `${stem}.annotated${suffix ? ` ${suffix}` : ""}.pdf`;
		suffix++;
	} while (exists(path));
	return path;
}

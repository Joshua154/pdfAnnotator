/**
 * Annotation data model.
 *
 * All coordinates are in PDF user-space units (1/72 inch), with the origin at
 * the TOP-LEFT of the page and the y-axis pointing DOWN. (PDF native space has
 * y pointing up; we flip once at render time so stored data matches intuitive
 * screen math and stays zoom-independent.)
 */

export type AnnotationType =
	| "ink"
	| "text"
	| "shape"
	| "text-highlight"
	| "image";

export type ShapeKind = "rect" | "ellipse" | "line" | "arrow";

export interface BaseAnnotation {
	id: string;
	type: AnnotationType;
}

/** Freehand pen or highlighter stroke. */
export interface InkAnnotation extends BaseAnnotation {
	type: "ink";
	color: string;
	/** Stroke width in PDF units. */
	width: number;
	/** 0–1; highlighter uses ~0.4, pen 1. */
	opacity: number;
	/** Polyline points [x, y][] in PDF units. */
	points: [number, number][];
}

/** Floating text box. */
export interface TextAnnotation extends BaseAnnotation {
	type: "text";
	x: number;
	y: number;
	w: number;
	h: number;
	text: string;
	color: string;
	/** Font size in PDF units. */
	fontSize: number;
}

/** Geometric shape drawn by dragging. */
export interface ShapeAnnotation extends BaseAnnotation {
	type: "shape";
	shape: ShapeKind;
	/** For rect/ellipse: bounding box (x,y = top-left). For line/arrow: x,y = start; x2,y2 = end. */
	x: number;
	y: number;
	x2: number;
	y2: number;
	color: string;
	width: number;
	opacity: number;
}

/** Highlight anchored to selected PDF text (one or more quads). */
export interface TextHighlightAnnotation extends BaseAnnotation {
	type: "text-highlight";
	color: string;
	/** Quoted text content, for the readable markdown line. */
	text: string;
	/** Rectangles covering the selection, in PDF units. */
	rects: { x: number; y: number; w: number; h: number }[];
	/** Optional PDF++-compatible selection params: [beginIdx, beginOffset, endIdx, endOffset]. */
	selection?: [number, number, number, number];
}

/** Pasted image, saved as a vault attachment and referenced by path. */
export interface ImageAnnotation extends BaseAnnotation {
	type: "image";
	x: number;
	y: number;
	w: number;
	h: number;
	/** Vault path of the image file (or a legacy data: URL). */
	src: string;
}

export type Annotation =
	| InkAnnotation
	| TextAnnotation
	| ShapeAnnotation
	| TextHighlightAnnotation
	| ImageAnnotation;

/** All annotations for a single page. */
export interface PageAnnotations {
	page: number; // 1-based
	items: Annotation[];
}

/** Full document model. */
export interface AnnotationDocument {
	/** Vault path of the annotated PDF. */
	pdfPath: string;
	pages: Map<number, PageAnnotations>;
}

let idCounter = 0;

export function generateId(): string {
	idCounter = (idCounter + 1) % 1296;
	return (
		Date.now().toString(36) +
		idCounter.toString(36).padStart(2, "0")
	);
}

export function createEmptyDocument(pdfPath: string): AnnotationDocument {
	return { pdfPath, pages: new Map() };
}

export function getOrCreatePage(
	doc: AnnotationDocument,
	page: number
): PageAnnotations {
	let p = doc.pages.get(page);
	if (!p) {
		p = { page, items: [] };
		doc.pages.set(page, p);
	}
	return p;
}

export function findAnnotation(
	doc: AnnotationDocument,
	page: number,
	id: string
): Annotation | undefined {
	return doc.pages.get(page)?.items.find((a) => a.id === id);
}

export function addAnnotation(
	doc: AnnotationDocument,
	page: number,
	ann: Annotation
): void {
	getOrCreatePage(doc, page).items.push(ann);
}

export function removeAnnotation(
	doc: AnnotationDocument,
	page: number,
	id: string
): Annotation | undefined {
	const p = doc.pages.get(page);
	if (!p) return undefined;
	const idx = p.items.findIndex((a) => a.id === id);
	if (idx < 0) return undefined;
	const [removed] = p.items.splice(idx, 1);
	if (p.items.length === 0) doc.pages.delete(page);
	return removed;
}

/** Deep-clone an annotation (for undo snapshots). */
export function cloneAnnotation<T extends Annotation>(ann: T): T {
	return JSON.parse(JSON.stringify(ann)) as T;
}

/** Axis-aligned bounding box of an annotation, in PDF units. */
export function annotationBBox(ann: Annotation): {
	x: number;
	y: number;
	w: number;
	h: number;
} {
	switch (ann.type) {
		case "ink": {
			let minX = Infinity,
				minY = Infinity,
				maxX = -Infinity,
				maxY = -Infinity;
			for (const [x, y] of ann.points) {
				if (x < minX) minX = x;
				if (y < minY) minY = y;
				if (x > maxX) maxX = x;
				if (y > maxY) maxY = y;
			}
			if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
			const pad = ann.width / 2;
			return {
				x: minX - pad,
				y: minY - pad,
				w: maxX - minX + ann.width,
				h: maxY - minY + ann.width,
			};
		}
		case "text":
		case "image":
			return { x: ann.x, y: ann.y, w: ann.w, h: ann.h };
		case "shape": {
			const x = Math.min(ann.x, ann.x2);
			const y = Math.min(ann.y, ann.y2);
			const pad = ann.width / 2;
			return {
				x: x - pad,
				y: y - pad,
				w: Math.abs(ann.x2 - ann.x) + ann.width,
				h: Math.abs(ann.y2 - ann.y) + ann.width,
			};
		}
		case "text-highlight": {
			let minX = Infinity,
				minY = Infinity,
				maxX = -Infinity,
				maxY = -Infinity;
			for (const r of ann.rects) {
				minX = Math.min(minX, r.x);
				minY = Math.min(minY, r.y);
				maxX = Math.max(maxX, r.x + r.w);
				maxY = Math.max(maxY, r.y + r.h);
			}
			if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
			return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
		}
	}
}

/** Translate an annotation by (dx, dy) in place. */
export function translateAnnotation(
	ann: Annotation,
	dx: number,
	dy: number
): void {
	switch (ann.type) {
		case "ink":
			for (const pt of ann.points) {
				pt[0] += dx;
				pt[1] += dy;
			}
			break;
		case "text":
		case "image":
			ann.x += dx;
			ann.y += dy;
			break;
		case "shape":
			ann.x += dx;
			ann.y += dy;
			ann.x2 += dx;
			ann.y2 += dy;
			break;
		case "text-highlight":
			for (const r of ann.rects) {
				r.x += dx;
				r.y += dy;
			}
			break;
	}
}

/**
 * Scale an annotation so its bbox maps from `from` to `to`.
 * Used by resize handles.
 */
export function scaleAnnotation(
	ann: Annotation,
	from: { x: number; y: number; w: number; h: number },
	to: { x: number; y: number; w: number; h: number }
): void {
	const sx = from.w > 0 ? to.w / from.w : 1;
	const sy = from.h > 0 ? to.h / from.h : 1;
	const mapX = (x: number) => to.x + (x - from.x) * sx;
	const mapY = (y: number) => to.y + (y - from.y) * sy;
	switch (ann.type) {
		case "ink":
			for (const pt of ann.points) {
				pt[0] = mapX(pt[0]);
				pt[1] = mapY(pt[1]);
			}
			break;
		case "image":
		case "text":
			ann.x = mapX(ann.x);
			ann.y = mapY(ann.y);
			ann.w *= sx;
			ann.h *= sy;
			break;
		case "shape": {
			const nx = mapX(ann.x);
			const ny = mapY(ann.y);
			const nx2 = mapX(ann.x2);
			const ny2 = mapY(ann.y2);
			ann.x = nx;
			ann.y = ny;
			ann.x2 = nx2;
			ann.y2 = ny2;
			break;
		}
		case "text-highlight":
			for (const r of ann.rects) {
				r.x = mapX(r.x);
				r.y = mapY(r.y);
				r.w *= sx;
				r.h *= sy;
			}
			break;
	}
}

import { Annotation, annotationBBox, cloneAnnotation, translateAnnotation } from "./annotations/model";

export const ANNOTATION_MIME = "application/x-obsidian-pdf-annotations";
const TEXT_PREFIX = "PDF Annotator clipboard\n";

export interface ClipboardItem {
	/** Offset in displayed page order, including inserted blank pages. */
	pageOffset: number;
	ann: Annotation;
}

export function writeAnnotations(data: DataTransfer, items: ClipboardItem[]): boolean {
	if (!items.length) return false;
	const json = JSON.stringify({ version: 1, items });
	try {
		// Plain text also supports hosts that discard custom clipboard formats.
		data.setData("text/plain", TEXT_PREFIX + json);
	} catch { return false; }
	try { data.setData(ANNOTATION_MIME, json); } catch { /* Plain-text fallback is sufficient. */ }
	return true;
}

export function readAnnotations(data: DataTransfer): ClipboardItem[] | null {
	try {
		const plain = data.getData("text/plain");
		const json = data.getData(ANNOTATION_MIME) || (plain.startsWith(TEXT_PREFIX) ? plain.slice(TEXT_PREFIX.length) : "");
		if (!json) return null;
		const payload = JSON.parse(json);
		if (payload.version !== 1 || !Array.isArray(payload.items) || !payload.items.length) return null;
		if (!payload.items.every((item: ClipboardItem) => item && Number.isSafeInteger(item.pageOffset) &&
			item.pageOffset >= 0 && validAnnotation(item.ann))) return null;
		if (!payload.items.some((item: ClipboardItem) => item.pageOffset === 0)) return null;
		return payload.items;
	} catch { return null; }
}

/** Clipboard contents come from outside the plugin; validate geometry before transforming it. */
function validAnnotation(value: unknown): value is Annotation {
	if (!value || typeof value !== "object") return false;
	const a = value as Annotation;
	const finite = (...values: unknown[]) => values.every(v => typeof v === "number" && Number.isFinite(v));
	const box = (b: { x: number; y: number; w: number; h: number }) =>
		finite(b.x, b.y, b.w, b.h) && b.w >= 0 && b.h >= 0;
	if (typeof a.id !== "string") return false;
	switch (a.type) {
		case "ink": return typeof a.color === "string" && finite(a.width, a.opacity) && a.width > 0 &&
			Array.isArray(a.points) && a.points.length > 0 && a.points.every(p => Array.isArray(p) && p.length === 2 && finite(...p));
		case "shape": return ["rect", "ellipse", "line", "arrow"].includes(a.shape) &&
			typeof a.color === "string" && finite(a.x, a.y, a.x2, a.y2, a.width, a.opacity) && a.width > 0;
		case "text": return box(a) && typeof a.text === "string" && typeof a.color === "string" && finite(a.fontSize) && a.fontSize > 0;
		case "image": return box(a) && typeof a.src === "string";
		case "latex": case "tikz": case "excalidraw": return box(a) && typeof a.source === "string" && a.source.trim().length > 0;
		case "text-highlight": return typeof a.color === "string" && typeof a.text === "string" &&
			Array.isArray(a.rects) && a.rects.length > 0 && a.rects.every(r => r && box(r)) &&
			(a.selection === undefined || (Array.isArray(a.selection) && a.selection.length === 4 &&
				a.selection.every(n => Number.isSafeInteger(n) && n >= 0)));
		default: return false;
	}
}

export function annotationBounds(items: Annotation[]): { x: number; y: number; w: number; h: number } {
	const bounds = items.map(annotationBBox);
	const x = Math.min(...bounds.map(b => b.x));
	const y = Math.min(...bounds.map(b => b.y));
	return { x, y, w: Math.max(...bounds.map(b => b.x + b.w)) - x, h: Math.max(...bounds.map(b => b.y + b.h)) - y };
}

/** Moving a text highlight detaches its old PDF text-selection link. */
export function translatedAnnotation(ann: Annotation, dx: number, dy: number, changedPage: boolean): Annotation {
	const copy = cloneAnnotation(ann);
	translateAnnotation(copy, dx, dy);
	if (copy.type === "text-highlight" && (changedPage || dx !== 0 || dy !== 0)) delete copy.selection;
	return copy;
}

/** Keep a transferred group visible without changing its size or internal spacing. */
export function fitAnnotations(items: Annotation[], width: number, height: number): void {
	const b = annotationBounds(items);
	const x = Math.max(0, Math.min(b.x, width - b.w));
	const y = Math.max(0, Math.min(b.y, height - b.h));
	for (const ann of items) {
		translateAnnotation(ann, x - b.x, y - b.y);
		if (ann.type === "text-highlight" && (x !== b.x || y !== b.y)) delete ann.selection;
	}
}

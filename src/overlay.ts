import {
	Annotation,
	ImageAnnotation,
	InkAnnotation,
	ShapeAnnotation,
	TextAnnotation,
	TextHighlightAnnotation,
	annotationBBox,
} from "./annotations/model";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Per-page SVG overlay. The viewBox equals the PDF page size in user-space
 * units, so annotation coordinates are zoom-independent: CSS size scales
 * with zoom while the coordinate system stays fixed.
 */
export class PageOverlay {
	readonly svg: SVGSVGElement;
	/** Layer holding committed annotations. */
	readonly itemsLayer: SVGGElement;
	/** Layer for in-progress drawing previews. */
	readonly draftLayer: SVGGElement;
	/** Layer for selection rectangles / handles. */
	readonly uiLayer: SVGGElement;

	readonly page: number;
	readonly pdfWidth: number;
	readonly pdfHeight: number;

	constructor(
		parent: HTMLElement,
		page: number,
		pdfWidth: number,
		pdfHeight: number
	) {
		this.page = page;
		this.pdfWidth = pdfWidth;
		this.pdfHeight = pdfHeight;

		this.svg = document.createElementNS(SVG_NS, "svg");
		this.svg.classList.add("pdf-annotator-overlay");
		this.svg.setAttribute("viewBox", `0 0 ${pdfWidth} ${pdfHeight}`);
		this.svg.setAttribute("preserveAspectRatio", "none");

		this.itemsLayer = document.createElementNS(SVG_NS, "g");
		this.draftLayer = document.createElementNS(SVG_NS, "g");
		this.uiLayer = document.createElementNS(SVG_NS, "g");
		this.svg.append(this.itemsLayer, this.draftLayer, this.uiLayer);

		parent.appendChild(this.svg);
	}

	/** Update CSS size to match the rendered page size at current zoom. */
	setDisplaySize(cssWidth: number, cssHeight: number): void {
		this.svg.style.width = `${cssWidth}px`;
		this.svg.style.height = `${cssHeight}px`;
	}

	/** Convert a pointer event's client coords to PDF user-space coords. */
	toPdfPoint(evt: { clientX: number; clientY: number }): [number, number] {
		const rect = this.svg.getBoundingClientRect();
		const x = ((evt.clientX - rect.left) / rect.width) * this.pdfWidth;
		const y = ((evt.clientY - rect.top) / rect.height) * this.pdfHeight;
		return [x, y];
	}

	/** Current scale: CSS pixels per PDF unit. */
	get scale(): number {
		const rect = this.svg.getBoundingClientRect();
		return rect.width > 0 ? rect.width / this.pdfWidth : 1;
	}

	// ------------------------------------------------------------------
	// Rendering
	// ------------------------------------------------------------------

	/** Re-render all committed annotations. */
	renderItems(items: Annotation[]): void {
		this.itemsLayer.replaceChildren();
		for (const ann of items) {
			const el = renderAnnotation(ann);
			if (el) this.itemsLayer.appendChild(el);
		}
	}

	clearDraft(): void {
		this.draftLayer.replaceChildren();
	}

	clearUi(): void {
		this.uiLayer.replaceChildren();
	}

	/** Find the annotation id for an element inside the items layer. */
	annotationIdAt(target: EventTarget | null): string | null {
		let el = target as Element | null;
		while (el && el !== this.svg) {
			if (el instanceof Element && el.hasAttribute("data-ann-id")) {
				return el.getAttribute("data-ann-id");
			}
			el = el.parentElement;
		}
		return null;
	}

	/**
	 * Hit-test: annotations whose geometry is within `tolerance` PDF units
	 * of the given point (used by the eraser).
	 */
	hitTest(
		items: Annotation[],
		x: number,
		y: number,
		tolerance: number
	): Annotation[] {
		const hits: Annotation[] = [];
		for (const ann of items) {
			if (annotationHit(ann, x, y, tolerance)) hits.push(ann);
		}
		return hits;
	}

	destroy(): void {
		this.svg.remove();
	}
}

// ----------------------------------------------------------------------
// SVG element construction per annotation type
// ----------------------------------------------------------------------

/**
 * Resolves an image annotation `src` (vault path) to a displayable URL.
 * Set once by the view (uses app.vault.getResourcePath). Data URLs pass
 * through unchanged.
 */
export let resolveImageSrc: (src: string) => string = (src) => src;

export function setImageSrcResolver(fn: (src: string) => string): void {
	resolveImageSrc = fn;
}

export function renderAnnotation(ann: Annotation): SVGElement | null {
	switch (ann.type) {
		case "ink":
			return renderInk(ann);
		case "text":
			return renderText(ann);
		case "shape":
			return renderShape(ann);
		case "text-highlight":
			return renderTextHighlight(ann);
		case "image":
			return renderImage(ann);
		default:
			return null;
	}
}

export function inkPathData(points: [number, number][]): string {
	if (points.length === 0) return "";
	if (points.length === 1) {
		const [x, y] = points[0];
		return `M ${x} ${y} L ${x + 0.01} ${y}`;
	}
	// Smooth with quadratic curves through midpoints
	let d = `M ${points[0][0]} ${points[0][1]}`;
	for (let i = 1; i < points.length - 1; i++) {
		const [x1, y1] = points[i];
		const [x2, y2] = points[i + 1];
		const mx = (x1 + x2) / 2;
		const my = (y1 + y2) / 2;
		d += ` Q ${x1} ${y1} ${mx} ${my}`;
	}
	const last = points[points.length - 1];
	d += ` L ${last[0]} ${last[1]}`;
	return d;
}

function baseGroup(ann: Annotation): SVGGElement {
	const g = document.createElementNS(SVG_NS, "g");
	g.setAttribute("data-ann-id", ann.id);
	g.classList.add("pdfann-item");
	return g;
}

function renderInk(ann: InkAnnotation): SVGElement {
	const g = baseGroup(ann);
	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("d", inkPathData(ann.points));
	path.setAttribute("fill", "none");
	path.setAttribute("stroke", ann.color);
	path.setAttribute("stroke-width", String(ann.width));
	path.setAttribute("stroke-linecap", "round");
	path.setAttribute("stroke-linejoin", "round");
	if (ann.opacity < 1) {
		path.setAttribute("stroke-opacity", String(ann.opacity));
		g.style.mixBlendMode = "multiply";
	}
	g.appendChild(path);
	return g;
}

function renderText(ann: TextAnnotation): SVGElement {
	const g = baseGroup(ann);
	const fo = document.createElementNS(SVG_NS, "foreignObject");
	fo.setAttribute("x", String(ann.x));
	fo.setAttribute("y", String(ann.y));
	fo.setAttribute("width", String(Math.max(ann.w, 10)));
	fo.setAttribute("height", String(Math.max(ann.h, 10)));
	const div = document.createElement("div");
	div.style.color = ann.color;
	div.style.fontSize = `${ann.fontSize}px`;
	div.style.lineHeight = "1.25";
	div.style.fontFamily = "var(--font-text, sans-serif)";
	div.style.whiteSpace = "pre-wrap";
	div.style.wordBreak = "break-word";
	div.style.width = "100%";
	div.style.height = "100%";
	div.style.overflow = "hidden";
	div.style.pointerEvents = "none";
	div.textContent = ann.text;
	fo.appendChild(div);
	// Transparent hit-rect so the group is clickable
	const hit = document.createElementNS(SVG_NS, "rect");
	hit.setAttribute("x", String(ann.x));
	hit.setAttribute("y", String(ann.y));
	hit.setAttribute("width", String(Math.max(ann.w, 10)));
	hit.setAttribute("height", String(Math.max(ann.h, 10)));
	hit.setAttribute("fill", "transparent");
	g.append(hit, fo);
	return g;
}

function renderShape(ann: ShapeAnnotation): SVGElement {
	const g = baseGroup(ann);
	let el: SVGElement;
	switch (ann.shape) {
		case "rect": {
			el = document.createElementNS(SVG_NS, "rect");
			el.setAttribute("x", String(Math.min(ann.x, ann.x2)));
			el.setAttribute("y", String(Math.min(ann.y, ann.y2)));
			el.setAttribute("width", String(Math.abs(ann.x2 - ann.x)));
			el.setAttribute("height", String(Math.abs(ann.y2 - ann.y)));
			el.setAttribute("fill", "none");
			break;
		}
		case "ellipse": {
			el = document.createElementNS(SVG_NS, "ellipse");
			el.setAttribute("cx", String((ann.x + ann.x2) / 2));
			el.setAttribute("cy", String((ann.y + ann.y2) / 2));
			el.setAttribute("rx", String(Math.abs(ann.x2 - ann.x) / 2));
			el.setAttribute("ry", String(Math.abs(ann.y2 - ann.y) / 2));
			el.setAttribute("fill", "none");
			break;
		}
		case "line": {
			el = document.createElementNS(SVG_NS, "line");
			el.setAttribute("x1", String(ann.x));
			el.setAttribute("y1", String(ann.y));
			el.setAttribute("x2", String(ann.x2));
			el.setAttribute("y2", String(ann.y2));
			break;
		}
		case "arrow": {
			el = document.createElementNS(SVG_NS, "g");
			const line = document.createElementNS(SVG_NS, "line");
			line.setAttribute("x1", String(ann.x));
			line.setAttribute("y1", String(ann.y));
			line.setAttribute("x2", String(ann.x2));
			line.setAttribute("y2", String(ann.y2));
			line.setAttribute("stroke", ann.color);
			line.setAttribute("stroke-width", String(ann.width));
			line.setAttribute("stroke-linecap", "round");
			// Arrow head
			const head = document.createElementNS(SVG_NS, "path");
			const angle = Math.atan2(ann.y2 - ann.y, ann.x2 - ann.x);
			const len = Math.max(ann.width * 4, 8);
			const a1 = angle + Math.PI - 0.45;
			const a2 = angle + Math.PI + 0.45;
			const hx1 = ann.x2 + Math.cos(a1) * len;
			const hy1 = ann.y2 + Math.sin(a1) * len;
			const hx2 = ann.x2 + Math.cos(a2) * len;
			const hy2 = ann.y2 + Math.sin(a2) * len;
			head.setAttribute(
				"d",
				`M ${hx1} ${hy1} L ${ann.x2} ${ann.y2} L ${hx2} ${hy2}`
			);
			head.setAttribute("fill", "none");
			head.setAttribute("stroke", ann.color);
			head.setAttribute("stroke-width", String(ann.width));
			head.setAttribute("stroke-linecap", "round");
			head.setAttribute("stroke-linejoin", "round");
			el.append(line, head);
			break;
		}
	}
	if (ann.shape !== "arrow") {
		el.setAttribute("stroke", ann.color);
		el.setAttribute("stroke-width", String(ann.width));
	}
	if (ann.opacity < 1) el.setAttribute("opacity", String(ann.opacity));
	g.appendChild(el);
	return g;
}

function renderImage(ann: ImageAnnotation): SVGElement {
	const g = baseGroup(ann);
	const img = document.createElementNS(SVG_NS, "image");
	img.setAttribute("x", String(ann.x));
	img.setAttribute("y", String(ann.y));
	img.setAttribute("width", String(Math.max(ann.w, 1)));
	img.setAttribute("height", String(Math.max(ann.h, 1)));
	img.setAttribute(
		"href",
		ann.src.startsWith("data:") ? ann.src : resolveImageSrc(ann.src)
	);
	img.setAttribute("preserveAspectRatio", "none");
	g.appendChild(img);
	return g;
}

function renderTextHighlight(ann: TextHighlightAnnotation): SVGElement {
	const g = baseGroup(ann);
	g.style.mixBlendMode = "multiply";
	for (const r of ann.rects) {
		const rect = document.createElementNS(SVG_NS, "rect");
		rect.setAttribute("x", String(r.x));
		rect.setAttribute("y", String(r.y));
		rect.setAttribute("width", String(r.w));
		rect.setAttribute("height", String(r.h));
		rect.setAttribute("fill", ann.color);
		rect.setAttribute("fill-opacity", "0.4");
		rect.setAttribute("rx", "1");
		g.appendChild(rect);
	}
	return g;
}

// ----------------------------------------------------------------------
// Hit testing (geometry-level, for eraser)
// ----------------------------------------------------------------------

function distToSegment(
	px: number,
	py: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number
): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lenSq = dx * dx + dy * dy;
	let t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
	t = Math.max(0, Math.min(1, t));
	const cx = x1 + t * dx;
	const cy = y1 + t * dy;
	return Math.hypot(px - cx, py - cy);
}

export function annotationHit(
	ann: Annotation,
	x: number,
	y: number,
	tolerance: number
): boolean {
	switch (ann.type) {
		case "ink": {
			const tol = tolerance + ann.width / 2;
			const pts = ann.points;
			if (pts.length === 1) {
				return Math.hypot(x - pts[0][0], y - pts[0][1]) <= tol;
			}
			for (let i = 0; i < pts.length - 1; i++) {
				if (
					distToSegment(
						x,
						y,
						pts[i][0],
						pts[i][1],
						pts[i + 1][0],
						pts[i + 1][1]
					) <= tol
				)
					return true;
			}
			return false;
		}
		case "text":
		case "image": {
			const b = annotationBBox(ann);
			return (
				x >= b.x - tolerance &&
				x <= b.x + b.w + tolerance &&
				y >= b.y - tolerance &&
				y <= b.y + b.h + tolerance
			);
		}
		case "shape": {
			const tol = tolerance + ann.width / 2;
			if (ann.shape === "line" || ann.shape === "arrow") {
				return (
					distToSegment(x, y, ann.x, ann.y, ann.x2, ann.y2) <= tol
				);
			}
			// rect/ellipse: hit near the outline
			const bx = Math.min(ann.x, ann.x2);
			const by = Math.min(ann.y, ann.y2);
			const bw = Math.abs(ann.x2 - ann.x);
			const bh = Math.abs(ann.y2 - ann.y);
			if (ann.shape === "rect") {
				const edges: [number, number, number, number][] = [
					[bx, by, bx + bw, by],
					[bx + bw, by, bx + bw, by + bh],
					[bx + bw, by + bh, bx, by + bh],
					[bx, by + bh, bx, by],
				];
				return edges.some(
					([ax, ay, cx, cy]) =>
						distToSegment(x, y, ax, ay, cx, cy) <= tol
				);
			}
			// ellipse: approximate via normalized radius
			const cx = bx + bw / 2;
			const cy = by + bh / 2;
			const rx = bw / 2;
			const ry = bh / 2;
			if (rx <= 0 || ry <= 0) return false;
			const norm = Math.hypot((x - cx) / rx, (y - cy) / ry);
			const tolNorm = tol / Math.min(rx, ry);
			return Math.abs(norm - 1) <= tolNorm;
		}
		case "text-highlight":
			return ann.rects.some(
				(r) =>
					x >= r.x - tolerance &&
					x <= r.x + r.w + tolerance &&
					y >= r.y - tolerance &&
					y <= r.y + r.h + tolerance
			);
	}
}

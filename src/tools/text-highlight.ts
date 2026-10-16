import {
	TextHighlightAnnotation,
	generateId,
} from "../annotations/model";
import { AddCommand } from "../history";
import { PageOverlay } from "../overlay";
import { Tool, ToolContext, ToolId } from "./tool";

/**
 * Text-selection highlight: the user selects text in the pdf.js text layer
 * (native browser selection); on pointer-up we convert the selection's
 * client rects into PDF-space quads and store them with the quoted text.
 *
 * While this tool is active, the page container gets class
 * `mode-text-select` which enables pointer events on the text layer and
 * disables them on the overlay (see styles.css).
 */
export class TextHighlightTool implements Tool {
	readonly id: ToolId = "text-highlight";

	private pointerUpHandler: ((evt: PointerEvent) => void) | null = null;
	private ctx: ToolContext | null = null;
	private ownerDocument: Document | null = null;
	private captureTimer: number | null = null;
	/** Set by the view: maps a text layer element to its overlay. */
	resolveOverlay: ((el: Element) => PageOverlay | null) | null = null;

	onActivate(ctx: ToolContext): void {
		this.onDeactivate();
		this.ctx = ctx;
		const doc = ctx.getPageContainer(1)?.ownerDocument ?? document;
		const win = doc.defaultView!;
		this.ownerDocument = doc;
		this.pointerUpHandler = () => {
			// Allow the browser to finalize the selection first
			if (this.captureTimer !== null) win.clearTimeout(this.captureTimer);
			this.captureTimer = win.setTimeout(() => {
				this.captureTimer = null;
				this.captureSelection();
			}, 10);
		};
		doc.addEventListener("pointerup", this.pointerUpHandler);
	}

	onDeactivate(): void {
		if (this.pointerUpHandler) {
			this.ownerDocument?.removeEventListener("pointerup", this.pointerUpHandler);
			this.pointerUpHandler = null;
		}
		if (this.captureTimer !== null) {
			this.ownerDocument?.defaultView?.clearTimeout(this.captureTimer);
			this.captureTimer = null;
		}
		this.ownerDocument = null;
		this.ctx = null;
	}

	// Pointer events on the overlay are disabled in this mode; these are
	// only called if events slip through — ignore them.
	onPointerDown(): void {}
	onPointerMove(): void {}
	onPointerUp(): void {}

	private captureSelection(): void {
		const ctx = this.ctx;
		if (!ctx || !this.resolveOverlay) return;
		const sel = this.ownerDocument?.defaultView?.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

		const range = sel.getRangeAt(0);
		const text = sel.toString().replace(/\s+/g, " ").trim();
		if (!text) return;

		// Find which text layer the selection belongs to
		const anchorEl =
			range.startContainer.nodeType === 1
				? range.startContainer as Element
				: range.startContainer.parentElement;
		if (!anchorEl) return;
		const textLayer = anchorEl.closest(".pdf-annotator-textlayer");
		if (!textLayer) return;
		const overlay = this.resolveOverlay(textLayer);
		if (!overlay) return;

		// Convert client rects → PDF units, merge near-duplicate lines
		const svgRect = overlay.svg.getBoundingClientRect();
		if (svgRect.width === 0) return;
		const sx = overlay.pdfWidth / svgRect.width;
		const sy = overlay.pdfHeight / svgRect.height;

		const rawRects: { x: number; y: number; w: number; h: number }[] = [];
		for (const r of Array.from(range.getClientRects())) {
			if (r.width < 1 || r.height < 1) continue;
			rawRects.push({
				x: (r.left - svgRect.left) * sx,
				y: (r.top - svgRect.top) * sy,
				w: r.width * sx,
				h: r.height * sy,
			});
		}
		const rects = mergeRects(rawRects);
		if (rects.length === 0) return;

		const ann: TextHighlightAnnotation = {
			id: generateId(),
			type: "text-highlight",
			color: ctx.options.highlighterColor,
			text,
			rects,
		};
		ctx.history.execute(ctx.doc, new AddCommand(overlay.page, ann));
		ctx.requestSave();
		sel.removeAllRanges();
	}
}

/** Merge overlapping/contained rects on the same text line. */
function mergeRects(
	rects: { x: number; y: number; w: number; h: number }[]
): { x: number; y: number; w: number; h: number }[] {
	const out: { x: number; y: number; w: number; h: number }[] = [];
	for (const r of rects) {
		let merged = false;
		for (const o of out) {
			const sameLine =
				Math.abs(r.y - o.y) < Math.min(r.h, o.h) * 0.5 &&
				Math.abs(r.y + r.h - (o.y + o.h)) < Math.min(r.h, o.h);
			const overlapX =
				r.x < o.x + o.w + 1 && o.x < r.x + r.w + 1;
			if (sameLine && overlapX) {
				const nx = Math.min(o.x, r.x);
				const ny = Math.min(o.y, r.y);
				const nx2 = Math.max(o.x + o.w, r.x + r.w);
				const ny2 = Math.max(o.y + o.h, r.y + r.h);
				o.x = nx;
				o.y = ny;
				o.w = nx2 - nx;
				o.h = ny2 - ny;
				merged = true;
				break;
			}
		}
		if (!merged) out.push({ ...r });
	}
	return out;
}

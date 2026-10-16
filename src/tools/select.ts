import {
	Annotation, annotationBBox, cloneAnnotation, findAnnotation, generateId,
	scaleAnnotation, RichAnnotation, isRichAnnotation,
} from "../annotations/model";
import { AnnotationLocation, ChangeAnnotationsCommand } from "../history";
import {
	ClipboardItem, annotationBounds, fitAnnotations, translatedAnnotation,
} from "../annotation-clipboard";
import { PageOverlay } from "../overlay";
import { Tool, ToolContext, ToolId } from "./tool";
import { TextBoxTool } from "./textbox";

const SVG_NS = "http://www.w3.org/2000/svg";
const HANDLE_SIZE = 6;
type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
interface Selection { page: number; id: string }
interface DragState {
	mode: "move" | "resize";
	handle?: HandleId;
	source: PageOverlay;
	pointerId: number;
	startX: number;
	startY: number;
	before: AnnotationLocation[];
	after: AnnotationLocation[] | null;
	previewPages: Set<number>;
	moved: boolean;
	event: PointerEvent;
}

/** Selection and atomic annotation transfers across PDF and blank pages. */
export class SelectTool implements Tool {
	readonly id: ToolId = "select";
	private selected: Selection[] = [];
	private uiOverlays = new Set<PageOverlay>();
	private drag: DragState | null = null;
	private scrollFrame: number | null = null;
	private scrollWindow: Window | null = null;
	private lastClickTime = 0;
	private lastClickId: string | null = null;
	private lastPaste = "";
	private pasteCount = 0;

	constructor(
		private textboxTool: TextBoxTool,
		private editRich?: (page: number, ann: RichAnnotation) => void,
	) {}

	onDeactivate(ctx: ToolContext): void {
		this.cancelDrag(ctx);
		this.clearSelection();
		this.lastClickId = null;
	}

	private clearUi(): void {
		for (const overlay of this.uiOverlays) overlay.clearUi();
		this.uiOverlays.clear();
	}

	private clearSelection(): void {
		this.clearUi();
		this.selected = [];
	}

	private locations(ctx: ToolContext): AnnotationLocation[] {
		const items: AnnotationLocation[] = [];
		if (!this.selected.length) return items;
		// Use page/stacking order rather than click order for clipboard and undo.
		for (const page of ctx.getPageOrder()) {
			for (const [index, ann] of (ctx.doc.pages.get(page)?.items ?? []).entries()) {
				if (this.selected.some(s => s.page === page && s.id === ann.id))
					items.push({ page, index, ann: cloneAnnotation(ann) });
			}
		}
		return items;
	}

	copy(ctx: ToolContext): ClipboardItem[] {
		if (this.drag) return [];
		const items = this.locations(ctx);
		const order = ctx.getPageOrder();
		const first = items.length ? order.indexOf(items[0].page) : 0;
		return items.map(item => ({ pageOffset: order.indexOf(item.page) - first, ann: item.ann }));
	}

	deleteSelection(ctx: ToolContext): boolean {
		if (this.drag) return false;
		const before = this.locations(ctx);
		if (!before.length) return false;
		this.clearSelection();
		ctx.history.execute(ctx.doc, new ChangeAnnotationsCommand(before, []));
		ctx.requestSave();
		return true;
	}

	/** Returns false if the entire page span cannot fit at the destination. */
	paste(ctx: ToolContext, items: ClipboardItem[], page: number, point?: [number, number]): boolean {
		if (!items.length) return false;
		const order = ctx.getPageOrder();
		const start = order.indexOf(page);
		if (start < 0 || items.some(item => start + item.pageOffset >= order.length)) return false;
		this.cancelDrag(ctx);
		const signature = JSON.stringify([items, page, point]);
		this.pasteCount = signature === this.lastPaste ? this.pasteCount + 1 : 1;
		this.lastPaste = signature;
		const bounds = annotationBounds(items.filter(item => item.pageOffset === 0).map(item => item.ann));
		const offset = 12 * this.pasteCount;
		const dx = point ? point[0] - bounds.x + offset - 12 : offset;
		const dy = point ? point[1] - bounds.y + offset - 12 : offset;
		const after = items.map(item => {
			const target = order[start + item.pageOffset];
			const ann = translatedAnnotation(item.ann, dx, dy, true);
			ann.id = generateId();
			return { page: target, index: Number.MAX_SAFE_INTEGER, ann };
		});
		this.fitToPages(after, ctx);
		this.selected = after.map(item => ({ page: item.page, id: item.ann.id }));
		ctx.history.execute(ctx.doc, new ChangeAnnotationsCommand([], after));
		ctx.requestSave();
		this.refresh(ctx);
		return true;
	}

	onPointerDown(evt: PointerEvent, overlay: PageOverlay, ctx: ToolContext): void {
		if (evt.button !== 0 || this.drag) return;
		evt.preventDefault();
		const [x, y] = overlay.toPdfPoint(evt);
		const handle = this.handleAt(evt.target);
		if (handle && this.selected.length === 1 && this.selected[0].page === overlay.page) {
			this.beginDrag(evt, overlay, ctx, x, y, handle);
			return;
		}
		const id = overlay.annotationIdAt(evt.target);
		const ann = id ? findAnnotation(ctx.doc, overlay.page, id) : null;
		if (!ann) {
			this.lastClickId = null;
			if (!evt.shiftKey) this.clearSelection();
			return;
		}
		const index = this.selected.findIndex(s => s.page === overlay.page && s.id === id);
		if (evt.shiftKey) {
			if (index >= 0) this.selected.splice(index, 1);
			else this.selected.push({ page: overlay.page, id: ann.id });
			this.lastClickId = null;
			this.refresh(ctx);
			return;
		}
		const clickId = `${overlay.page}:${id}`;
		if (this.selected.length === 1 && this.lastClickId === clickId && Date.now() - this.lastClickTime < 400 &&
			(ann.type === "text" || isRichAnnotation(ann))) {
			this.clearSelection();
			if (ann.type === "text") this.textboxTool.beginEdit(overlay, ctx, ann);
			else if (isRichAnnotation(ann)) this.editRich?.(overlay.page, ann);
			this.lastClickId = null;
			return;
		}
		this.lastClickId = clickId;
		this.lastClickTime = Date.now();
		if (index < 0) this.selected = [{ page: overlay.page, id: ann.id }];
		this.refresh(ctx);
		this.beginDrag(evt, overlay, ctx, x, y);
	}

	private beginDrag(evt: PointerEvent, overlay: PageOverlay, ctx: ToolContext, x: number, y: number, handle?: HandleId): void {
		this.drag = {
			mode: handle ? "resize" : "move", handle, source: overlay, pointerId: evt.pointerId,
			startX: x, startY: y, before: this.locations(ctx), after: null,
			previewPages: new Set(), moved: false, event: evt,
		};
		overlay.svg.setPointerCapture(evt.pointerId);
	}

	onPointerMove(evt: PointerEvent, _overlay: PageOverlay, ctx: ToolContext): void {
		if (!this.drag || evt.pointerId !== this.drag.pointerId) return;
		evt.preventDefault();
		this.drag.event = evt;
		this.updateDrag(ctx);
		this.startAutoScroll(ctx);
	}

	private updateDrag(ctx: ToolContext): void {
		const drag = this.drag;
		if (!drag) return;
		const [sx, sy] = drag.source.toPdfPoint(drag.event);
		if (!drag.moved && Math.hypot(sx - drag.startX, sy - drag.startY) * drag.source.scale < 3) return;
		drag.moved = true;
		this.lastClickId = null;
		const target = drag.mode === "resize" ? drag.source : ctx.getOverlayAtPoint(drag.event.clientX, drag.event.clientY);
		let after: AnnotationLocation[] | null = null;
		if (target) {
			const [x, y] = target.toPdfPoint(drag.event);
			const dx = x - drag.startX, dy = y - drag.startY;
			const order = ctx.getPageOrder();
			const shift = order.indexOf(target.page) - order.indexOf(drag.source.page);
			if (drag.before.every(item => order[order.indexOf(item.page) + shift] !== undefined)) {
				after = drag.before.map(item => {
					const page = order[order.indexOf(item.page) + shift];
					const ann = drag.mode === "move" ? translatedAnnotation(item.ann, dx, dy, page !== item.page) : cloneAnnotation(item.ann);
					if (drag.mode === "resize") {
						const b = annotationBBox(ann), nb = { ...b }, h = drag.handle!;
						if (h.includes("w")) { nb.x += dx; nb.w -= dx; }
						if (h.includes("e")) nb.w += dx;
						if (h.includes("n")) { nb.y += dy; nb.h -= dy; }
						if (h.includes("s")) nb.h += dy;
						nb.w = Math.max(4, nb.w); nb.h = Math.max(4, nb.h);
						scaleAnnotation(ann, b, nb);
					}
					return { page, index: page === item.page ? item.index : Number.MAX_SAFE_INTEGER, ann };
				});
				if (shift !== 0) this.fitToPages(after, ctx);
			}
		}
		drag.after = after;
		drag.source.svg.style.cursor = after ? (drag.mode === "move" ? "grabbing" : "") : "not-allowed";
		this.renderDrag(ctx);
	}

	private fitToPages(items: AnnotationLocation[], ctx: ToolContext): void {
		for (const page of new Set(items.map(item => item.page))) {
			const overlay = ctx.getPageOverlay(page);
			if (overlay) fitAnnotations(items.filter(item => item.page === page).map(item => item.ann), overlay.pdfWidth, overlay.pdfHeight);
		}
	}

	/** Preview only: autosave must never persist a half-finished transfer. */
	private renderDrag(ctx: ToolContext): void {
		const drag = this.drag!;
		const after = drag.after ?? drag.before;
		const currentPages = new Set([...drag.before.map(i => i.page), ...after.map(i => i.page)]);
		const pages = new Set([...drag.previewPages, ...currentPages]);
		this.clearUi();
		for (const page of pages) {
			const overlay = ctx.getPageOverlay(page);
			if (!overlay) continue;
			const items = (ctx.doc.pages.get(page)?.items ?? []).filter(ann => !drag.before.some(i => i.page === page && i.ann.id === ann.id));
			for (const item of after.filter(i => i.page === page).sort((a, b) => a.index - b.index)) items.splice(item.index, 0, item.ann);
			overlay.renderItems(items);
		}
		drag.previewPages = currentPages;
		this.showSelection(after, ctx);
	}

	onPointerUp(evt: PointerEvent, _overlay: PageOverlay, ctx: ToolContext): void {
		const drag = this.drag;
		if (!drag || evt.pointerId !== drag.pointerId) return;
		drag.event = evt;
		this.updateDrag(ctx);
		const after = drag.after;
		this.finishDrag(ctx);
		if (drag.moved && after && JSON.stringify(after) !== JSON.stringify(drag.before)) {
			this.selected = after.map(item => ({ page: item.page, id: item.ann.id }));
			ctx.history.execute(ctx.doc, new ChangeAnnotationsCommand(drag.before, after));
			ctx.requestSave();
		}
		this.refresh(ctx);
	}

	onPointerCancel(evt: PointerEvent, _overlay: PageOverlay, ctx: ToolContext): void {
		if (evt.pointerId === this.drag?.pointerId) this.cancelDrag(ctx);
	}

	private finishDrag(ctx: ToolContext): void {
		const drag = this.drag;
		this.drag = null;
		if (this.scrollFrame !== null) this.scrollWindow?.cancelAnimationFrame(this.scrollFrame);
		this.scrollFrame = null;
		this.scrollWindow = null;
		if (!drag) return;
		drag.source.svg.style.cursor = "";
		if (drag.source.svg.hasPointerCapture(drag.pointerId)) drag.source.svg.releasePointerCapture(drag.pointerId);
		for (const page of drag.previewPages) ctx.requestRender(page);
	}

	cancelDrag(ctx: ToolContext): void {
		this.finishDrag(ctx);
		this.refresh(ctx);
	}

	/** Also refresh when the user scrolls with a wheel during a captured drag. */
	onScroll(ctx: ToolContext): void { if (this.drag?.moved) this.updateDrag(ctx); }

	private startAutoScroll(ctx: ToolContext): void {
		if (this.scrollFrame !== null || !this.drag?.moved || this.drag.mode !== "move") return;
		const scroll = ctx.getScrollContainer(), win = scroll?.ownerDocument.defaultView;
		if (!scroll || !win) return;
		this.scrollWindow = win;
		let previous = 0;
		const tick = (time: number) => {
			this.scrollFrame = null;
			if (!this.drag) return;
			const rect = scroll.getBoundingClientRect(), evt = this.drag.event;
			const edge = Math.min(48, rect.height / 4);
			if (edge <= 0) return;
			if (evt.clientX < rect.left || evt.clientX > rect.right || evt.clientY < rect.top - edge || evt.clientY > rect.bottom + edge) return;
			const speed = evt.clientY < rect.top + edge ? -Math.min(1, (rect.top + edge - evt.clientY) / edge) :
				evt.clientY > rect.bottom - edge ? Math.min(1, (evt.clientY - rect.bottom + edge) / edge) : 0;
			if (!speed) return;
			const before = scroll.scrollTop;
			scroll.scrollTop += speed * 700 * (previous ? Math.min(time - previous, 32) : 16) / 1000;
			previous = time;
			if (scroll.scrollTop === before) return;
			this.updateDrag(ctx);
			this.scrollFrame = win.requestAnimationFrame(tick);
		};
		this.scrollFrame = win.requestAnimationFrame(tick);
	}

	onKeyDown(evt: KeyboardEvent, ctx: ToolContext): boolean {
		if (evt.key === "Escape") {
			if (this.drag) { this.cancelDrag(ctx); return true; }
			if (this.selected.length) { this.clearSelection(); return true; }
		}
		if (this.drag) return false;
		if ((evt.ctrlKey || evt.metaKey) && !evt.altKey && evt.key.toLowerCase() === "a") {
			this.selected = ctx.getPageOrder().flatMap(page => (ctx.doc.pages.get(page)?.items ?? []).map(ann => ({ page, id: ann.id })));
			this.refresh(ctx);
			return true;
		}
		if (evt.key === "Delete" || evt.key === "Backspace") return this.deleteSelection(ctx);
		return false;
	}

	refresh(ctx: ToolContext): void {
		if (this.drag?.moved) { this.renderDrag(ctx); return; }
		this.selected = this.selected.filter(s => findAnnotation(ctx.doc, s.page, s.id));
		this.clearUi();
		this.showSelection(this.locations(ctx), ctx);
	}

	private showSelection(items: AnnotationLocation[], ctx: ToolContext): void {
		for (const item of items) {
			const overlay = ctx.getPageOverlay(item.page);
			if (!overlay) continue;
			this.uiOverlays.add(overlay);
			this.renderSelectionUi(overlay, item.ann, items.length === 1);
		}
	}

	private handleAt(target: EventTarget | null): HandleId | null {
		return (target as Element | null)?.getAttribute?.("data-handle") as HandleId | null;
	}

	private renderSelectionUi(overlay: PageOverlay, ann: Annotation, handles: boolean): void {
		const b = annotationBBox(ann);
		const pad = 2;
		const bx = b.x - pad;
		const by = b.y - pad;
		const bw = b.w + pad * 2;
		const bh = b.h + pad * 2;

		const rect = overlay.svg.ownerDocument.createElementNS(SVG_NS, "rect");
		rect.classList.add("pdfann-selection-rect");
		rect.setAttribute("x", String(bx));
		rect.setAttribute("y", String(by));
		rect.setAttribute("width", String(bw));
		rect.setAttribute("height", String(bh));
		overlay.uiLayer.appendChild(rect);

		// Resize handles (skip for text-highlights — anchored to text)
		if (!handles || ann.type === "text-highlight") return;

		const s = HANDLE_SIZE / Math.max(overlay.scale, 0.1);
		const positions: [HandleId, number, number][] = [
			["nw", bx, by],
			["n", bx + bw / 2, by],
			["ne", bx + bw, by],
			["e", bx + bw, by + bh / 2],
			["se", bx + bw, by + bh],
			["s", bx + bw / 2, by + bh],
			["sw", bx, by + bh],
			["w", bx, by + bh / 2],
		];
		const cursors: Record<HandleId, string> = {
			nw: "nwse-resize",
			n: "ns-resize",
			ne: "nesw-resize",
			e: "ew-resize",
			se: "nwse-resize",
			s: "ns-resize",
			sw: "nesw-resize",
			w: "ew-resize",
		};
		for (const [hid, hx, hy] of positions) {
			const h = overlay.svg.ownerDocument.createElementNS(SVG_NS, "rect");
			h.classList.add("pdfann-resize-handle");
			h.setAttribute("data-handle", hid);
			h.setAttribute("x", String(hx - s / 2));
			h.setAttribute("y", String(hy - s / 2));
			h.setAttribute("width", String(s));
			h.setAttribute("height", String(s));
			h.style.cursor = cursors[hid];
			overlay.uiLayer.appendChild(h);
		}
	}
}

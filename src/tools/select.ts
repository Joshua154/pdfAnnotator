import {
	Annotation,
	annotationBBox,
	cloneAnnotation,
	findAnnotation,
	scaleAnnotation,
	translateAnnotation,
	RichAnnotation,
	isRichAnnotation,
} from "../annotations/model";
import { RemoveCommand, UpdateCommand } from "../history";
import { PageOverlay } from "../overlay";
import { Tool, ToolContext, ToolId } from "./tool";
import { TextBoxTool } from "./textbox";

const SVG_NS = "http://www.w3.org/2000/svg";
const HANDLE_SIZE = 6; // CSS px, converted by scale

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

interface DragState {
	mode: "move" | "resize";
	handle?: HandleId;
	startX: number;
	startY: number;
	/** Snapshot of annotation before drag, for undo. */
	before: Annotation;
	startBBox: { x: number; y: number; w: number; h: number };
	moved: boolean;
}

/** Select tool: click to select; drag to move; handles to resize; Delete to remove. */
export class SelectTool implements Tool {
	readonly id: ToolId = "select";

	private selectedId: string | null = null;
	private selectedPage = 0;
	private overlay: PageOverlay | null = null;
	private drag: DragState | null = null;
	private lastClickTime = 0;
	private lastClickId: string | null = null;

	constructor(
		private textboxTool: TextBoxTool,
		private editRich?: (page: number, ann: RichAnnotation) => void,
	) {}

	onDeactivate(ctx: ToolContext): void {
		this.clearSelection(ctx);
	}

	private clearSelection(_ctx: ToolContext): void {
		this.overlay?.clearUi();
		this.selectedId = null;
		this.overlay = null;
	}

	private getSelected(ctx: ToolContext): Annotation | null {
		if (!this.selectedId) return null;
		return (
			findAnnotation(ctx.doc, this.selectedPage, this.selectedId) ?? null
		);
	}

	onPointerDown(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		if (evt.button !== 0) return;
		evt.preventDefault();

		const [x, y] = overlay.toPdfPoint(evt);

		// Clicked a resize handle?
		const handleId = this.handleAt(evt.target);
		const selected = this.getSelected(ctx);
		if (handleId && selected && overlay === this.overlay) {
			this.drag = {
				mode: "resize",
				handle: handleId,
				startX: x,
				startY: y,
				before: cloneAnnotation(selected),
				startBBox: annotationBBox(selected),
				moved: false,
			};
			overlay.svg.setPointerCapture(evt.pointerId);
			return;
		}

		// Clicked an annotation?
		const id = overlay.annotationIdAt(evt.target);
		if (id) {
			const ann = findAnnotation(ctx.doc, overlay.page, id);
			if (ann) {
				// Double-click on editable content → edit source or open drawing.
				const now = Date.now();
				if (
					(ann.type === "text" || isRichAnnotation(ann)) &&
					this.lastClickId === id &&
					now - this.lastClickTime < 400
				) {
					this.clearSelection(ctx);
					this.drag = null;
					if (ann.type === "text") this.textboxTool.beginEdit(overlay, ctx, ann);
					else if (isRichAnnotation(ann)) this.editRich?.(overlay.page, ann);
					this.lastClickId = null;
					return;
				}
				this.lastClickTime = now;
				this.lastClickId = id;

				// Select & begin move
				if (this.overlay && this.overlay !== overlay)
					this.overlay.clearUi();
				this.selectedId = id;
				this.selectedPage = overlay.page;
				this.overlay = overlay;
				this.renderSelectionUi(overlay, ann);
				this.drag = {
					mode: "move",
					startX: x,
					startY: y,
					before: cloneAnnotation(ann),
					startBBox: annotationBBox(ann),
					moved: false,
				};
				overlay.svg.setPointerCapture(evt.pointerId);
				return;
			}
		}

		// Clicked empty space → deselect
		this.lastClickId = null;
		this.clearSelection(ctx);
	}

	onPointerMove(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		if (!this.drag || overlay !== this.overlay) return;
		const ann = this.getSelected(ctx);
		if (!ann) return;
		evt.preventDefault();

		const [x, y] = overlay.toPdfPoint(evt);
		const dx = x - this.drag.startX;
		const dy = y - this.drag.startY;
		if (!this.drag.moved && Math.hypot(dx, dy) < 1) return;
		this.drag.moved = true;

		// Reset to snapshot, then apply transform — avoids drift
		const fresh = cloneAnnotation(this.drag.before);

		if (this.drag.mode === "move") {
			translateAnnotation(fresh, dx, dy);
		} else {
			const b = this.drag.startBBox;
			const nb = { ...b };
			const h = this.drag.handle!;
			if (h.includes("w")) {
				nb.x = b.x + dx;
				nb.w = b.w - dx;
			}
			if (h.includes("e")) nb.w = b.w + dx;
			if (h.includes("n")) {
				nb.y = b.y + dy;
				nb.h = b.h - dy;
			}
			if (h.includes("s")) nb.h = b.h + dy;
			// Prevent inversion
			if (nb.w < 4) nb.w = 4;
			if (nb.h < 4) nb.h = 4;
			scaleAnnotation(fresh, b, nb);
		}

		// Write transformed values back into the live annotation
		Object.assign(ann, fresh);
		ctx.requestRender(overlay.page);
		this.renderSelectionUi(overlay, ann);
	}

	onPointerUp(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		if (!this.drag || overlay !== this.overlay) return;
		const drag = this.drag;
		this.drag = null;
		const ann = this.getSelected(ctx);
		if (!ann) return;

		if (drag.moved) {
			// Model already holds final state; record for undo
			ctx.history.push(
				new UpdateCommand(this.selectedPage, drag.before, ann)
			);
			ctx.requestSave();
			this.renderSelectionUi(overlay, ann);
		}
	}

	onKeyDown(evt: KeyboardEvent, ctx: ToolContext): boolean {
		if (evt.key === "Delete" || evt.key === "Backspace") {
			const ann = this.getSelected(ctx);
			if (ann && this.overlay) {
				ctx.history.execute(
					ctx.doc,
					new RemoveCommand(this.selectedPage, ann)
				);
				ctx.requestSave();
				this.clearSelection(ctx);
				return true;
			}
		} else if (evt.key === "Escape") {
			if (this.selectedId) {
				this.clearSelection(ctx);
				return true;
			}
		}
		return false;
	}

	/** Re-render selection UI after external changes (zoom, undo). */
	refresh(ctx: ToolContext): void {
		if (!this.overlay) return;
		const ann = this.getSelected(ctx);
		if (ann) this.renderSelectionUi(this.overlay, ann);
		else this.clearSelection(ctx);
	}

	// ------------------------------------------------------------------

	private handleAt(target: EventTarget | null): HandleId | null {
		if (
			target instanceof Element &&
			target.hasAttribute("data-handle")
		) {
			return target.getAttribute("data-handle") as HandleId;
		}
		return null;
	}

	private renderSelectionUi(overlay: PageOverlay, ann: Annotation): void {
		overlay.clearUi();
		const b = annotationBBox(ann);
		const pad = 2;
		const bx = b.x - pad;
		const by = b.y - pad;
		const bw = b.w + pad * 2;
		const bh = b.h + pad * 2;

		const rect = document.createElementNS(SVG_NS, "rect");
		rect.classList.add("pdfann-selection-rect");
		rect.setAttribute("x", String(bx));
		rect.setAttribute("y", String(by));
		rect.setAttribute("width", String(bw));
		rect.setAttribute("height", String(bh));
		overlay.uiLayer.appendChild(rect);

		// Resize handles (skip for text-highlights — anchored to text)
		if (ann.type === "text-highlight") return;

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
			const h = document.createElementNS(SVG_NS, "rect");
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

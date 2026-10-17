import { ShapeAnnotation, generateId } from "../annotations/model";
import { AddCommand } from "../history";
import { PageOverlay, renderAnnotation } from "../overlay";
import { Tool, ToolContext, ToolId } from "./tool";

/** Drag to draw rect / ellipse / line / arrow. */
export class ShapeTool implements Tool {
	readonly id: ToolId = "shape";

	private pointerId: number | null = null;
	private activeOverlay: PageOverlay | null = null;
	private draft: ShapeAnnotation | null = null;

	onPointerDown(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		if (evt.button !== 0 || this.pointerId !== null) return;
		evt.preventDefault();
		const [x, y] = overlay.toPdfPoint(evt);
		this.pointerId = evt.pointerId;
		this.activeOverlay = overlay;
		this.draft = {
			id: generateId(),
			type: "shape",
			shape: ctx.options.shapeKind,
			x,
			y,
			x2: x,
			y2: y,
			color: ctx.options.penColor,
			width: ctx.options.penWidth,
			opacity: 1,
		};
		overlay.svg.setPointerCapture(evt.pointerId);
		this.renderDraft(overlay);
	}

	onPointerMove(evt: PointerEvent, overlay: PageOverlay): void {
		if (evt.pointerId !== this.pointerId || !this.draft || overlay !== this.activeOverlay)
			return;
		evt.preventDefault();
		const [x, y] = overlay.toPdfPoint(evt);
		this.draft.x2 = x;
		this.draft.y2 = y;
		if (evt.shiftKey) {
			// Constrain: square/circle or 45° lines
			const dx = this.draft.x2 - this.draft.x;
			const dy = this.draft.y2 - this.draft.y;
			if (this.draft.shape === "rect" || this.draft.shape === "ellipse") {
				const s = Math.max(Math.abs(dx), Math.abs(dy));
				this.draft.x2 = this.draft.x + Math.sign(dx || 1) * s;
				this.draft.y2 = this.draft.y + Math.sign(dy || 1) * s;
			} else {
				const angle = Math.atan2(dy, dx);
				const snapped =
					(Math.round(angle / (Math.PI / 4)) * Math.PI) / 4;
				const len = Math.hypot(dx, dy);
				this.draft.x2 = this.draft.x + Math.cos(snapped) * len;
				this.draft.y2 = this.draft.y + Math.sin(snapped) * len;
			}
		}
		this.renderDraft(overlay);
	}

	onPointerUp(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		if (evt.pointerId !== this.pointerId || !this.draft || overlay !== this.activeOverlay)
			return;
		this.onPointerMove(evt, overlay);
		const d = this.draft;
		this.onDeactivate();
		// Discard degenerate shapes (click without drag)
		if (Math.hypot(d.x2 - d.x, d.y2 - d.y) < 2) return;
		ctx.history.execute(ctx.doc, new AddCommand(overlay.page, d));
		ctx.requestSave();
	}

	onPointerCancel(evt: PointerEvent): void {
		if (evt.pointerId === this.pointerId) this.onDeactivate();
	}

	onDeactivate(): void {
		const overlay = this.activeOverlay, id = this.pointerId;
		this.pointerId = null;
		this.activeOverlay = null;
		this.draft = null;
		overlay?.clearDraft();
		if (id !== null && overlay?.svg.hasPointerCapture(id)) overlay.svg.releasePointerCapture(id);
	}

	private renderDraft(overlay: PageOverlay): void {
		overlay.clearDraft();
		if (!this.draft) return;
		const el = renderAnnotation(this.draft);
		if (el) overlay.draftLayer.appendChild(el);
	}
}

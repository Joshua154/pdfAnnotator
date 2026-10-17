import { AnnotationLocation, ChangeAnnotationsCommand } from "../history";
import { PageOverlay } from "../overlay";
import { Tool, ToolContext, ToolId } from "./tool";

/** Eraser previews removals until release so a pinch can safely cancel them. */
export class EraserTool implements Tool {
	readonly id: ToolId = "eraser";

	private pointerId: number | null = null;
	private activeOverlay: PageOverlay | null = null;
	private removed = new Map<string, AnnotationLocation>();

	private eraseAt(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		const [x, y] = overlay.toPdfPoint(evt);
		const items = ctx.getPageItems(overlay.page);
		// Tolerance scales inversely with zoom so it feels constant on screen
		const tol = 4 / Math.max(overlay.scale, 0.1);
		let changed = false;
		for (const hit of overlay.hitTest(items, x, y, tol)) {
			if (this.removed.has(hit.id)) continue;
			this.removed.set(hit.id, { page: overlay.page, index: items.indexOf(hit), ann: hit });
			changed = true;
		}
		if (changed) overlay.renderItems(items.filter(ann => !this.removed.has(ann.id)));
	}

	onPointerDown(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		if (evt.button !== 0 || this.pointerId !== null) return;
		evt.preventDefault();
		this.pointerId = evt.pointerId;
		this.activeOverlay = overlay;
		overlay.svg.setPointerCapture(evt.pointerId);
		this.eraseAt(evt, overlay, ctx);
	}

	onPointerMove(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		if (evt.pointerId !== this.pointerId || overlay !== this.activeOverlay) return;
		evt.preventDefault();
		this.eraseAt(evt, overlay, ctx);
	}

	onPointerUp(evt: PointerEvent, overlay: PageOverlay, ctx: ToolContext): void {
		if (evt.pointerId !== this.pointerId || overlay !== this.activeOverlay) return;
		this.eraseAt(evt, overlay, ctx);
		const removed = [...this.removed.values()];
		this.onDeactivate(ctx);
		if (!removed.length) return;
		ctx.history.execute(ctx.doc, new ChangeAnnotationsCommand(removed, []));
		ctx.requestSave();
	}

	onPointerCancel(evt: PointerEvent, _overlay: PageOverlay, ctx: ToolContext): void {
		if (evt.pointerId === this.pointerId) this.onDeactivate(ctx);
	}

	onDeactivate(ctx: ToolContext): void {
		const overlay = this.activeOverlay, id = this.pointerId;
		this.pointerId = null;
		this.activeOverlay = null;
		this.removed.clear();
		if (id !== null && overlay?.svg.hasPointerCapture(id)) overlay.svg.releasePointerCapture(id);
		if (overlay) ctx.requestRender(overlay.page);
	}
}

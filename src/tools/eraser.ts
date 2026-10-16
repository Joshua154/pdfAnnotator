import { RemoveCommand } from "../history";
import { PageOverlay } from "../overlay";
import { Tool, ToolContext, ToolId } from "./tool";

/** Eraser: drag over annotations to remove whole items. */
export class EraserTool implements Tool {
	readonly id: ToolId = "eraser";

	private erasing = false;

	private eraseAt(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		const [x, y] = overlay.toPdfPoint(evt);
		const items = ctx.getPageItems(overlay.page);
		// Tolerance scales inversely with zoom so it feels constant on screen
		const tol = 4 / Math.max(overlay.scale, 0.1);
		const hits = overlay.hitTest(items, x, y, tol);
		for (const hit of hits) {
			ctx.history.execute(
				ctx.doc,
				new RemoveCommand(overlay.page, hit)
			);
		}
		if (hits.length) ctx.requestSave();
	}

	onPointerDown(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		if (evt.button !== 0) return;
		evt.preventDefault();
		this.erasing = true;
		overlay.svg.setPointerCapture(evt.pointerId);
		this.eraseAt(evt, overlay, ctx);
	}

	onPointerMove(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		if (!this.erasing) return;
		evt.preventDefault();
		this.eraseAt(evt, overlay, ctx);
	}

	onPointerUp(): void {
		this.erasing = false;
	}
}

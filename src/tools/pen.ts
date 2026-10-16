import { InkAnnotation, generateId } from "../annotations/model";
import { AddCommand } from "../history";
import { PageOverlay, inkPathData } from "../overlay";
import { Tool, ToolContext, ToolId } from "./tool";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Minimum distance (PDF units) between captured points. */
const MIN_DIST = 0.7;

/**
 * Freehand drawing tool. Base class for pen and highlighter — the only
 * difference is stroke style (color/width/opacity/blend).
 */
export class PenTool implements Tool {
	readonly id: ToolId = "pen";

	private drawing = false;
	private activeOverlay: PageOverlay | null = null;
	private points: [number, number][] = [];
	private previewPath: SVGPathElement | null = null;

	protected getStyle(ctx: ToolContext): {
		color: string;
		width: number;
		opacity: number;
	} {
		return {
			color: ctx.options.penColor,
			width: ctx.options.penWidth,
			opacity: 1,
		};
	}

	onPointerDown(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		if (evt.button !== 0) return;
		evt.preventDefault();
		this.drawing = true;
		this.activeOverlay = overlay;
		this.points = [overlay.toPdfPoint(evt)];

		const style = this.getStyle(ctx);
		const path = document.createElementNS(SVG_NS, "path");
		path.setAttribute("fill", "none");
		path.setAttribute("stroke", style.color);
		path.setAttribute("stroke-width", String(style.width));
		path.setAttribute("stroke-linecap", "round");
		path.setAttribute("stroke-linejoin", "round");
		if (style.opacity < 1) {
			path.setAttribute("stroke-opacity", String(style.opacity));
			path.style.mixBlendMode = "multiply";
		}
		overlay.draftLayer.appendChild(path);
		this.previewPath = path;

		overlay.svg.setPointerCapture(evt.pointerId);
	}

	onPointerMove(evt: PointerEvent, overlay: PageOverlay): void {
		if (!this.drawing || overlay !== this.activeOverlay) return;
		evt.preventDefault();
		const pt = overlay.toPdfPoint(evt);
		const last = this.points[this.points.length - 1];
		if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < MIN_DIST) return;
		this.points.push(pt);
		this.previewPath?.setAttribute("d", inkPathData(this.points));
	}

	onPointerUp(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		if (!this.drawing || overlay !== this.activeOverlay) return;
		this.drawing = false;
		overlay.clearDraft();
		this.previewPath = null;

		if (this.points.length === 0) return;
		const style = this.getStyle(ctx);
		const ann: InkAnnotation = {
			id: generateId(),
			type: "ink",
			color: style.color,
			width: style.width,
			opacity: style.opacity,
			points: this.points,
		};
		this.points = [];
		ctx.history.execute(ctx.doc, new AddCommand(overlay.page, ann));
		ctx.requestSave();
	}
}

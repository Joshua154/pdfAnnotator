import { PenTool } from "./pen";
import { ToolContext, ToolId } from "./tool";

/** Wide, translucent freehand stroke with multiply blending. */
export class HighlighterTool extends PenTool {
	readonly id: ToolId = "highlighter";

	protected getStyle(ctx: ToolContext): {
		color: string;
		width: number;
		opacity: number;
	} {
		return {
			color: ctx.options.highlighterColor,
			width: ctx.options.highlighterWidth,
			opacity: 0.4,
		};
	}
}

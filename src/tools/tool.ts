import { Annotation, AnnotationDocument, ShapeKind } from "../annotations/model";
import { History } from "../history";
import { PageOverlay } from "../overlay";

export type ToolId =
	| "select"
	| "pen"
	| "highlighter"
	| "eraser"
	| "text"
	| "shape"
	| "text-highlight";

/** Live drawing options shared by tools, controlled by the toolbar. */
export interface ToolOptions {
	penColor: string;
	penWidth: number;
	highlighterColor: string;
	highlighterWidth: number;
	shapeKind: ShapeKind;
	fontSize: number;
	textColor: string;
}

/** Services the view exposes to tools. */
export interface ToolContext {
	readonly doc: AnnotationDocument;
	readonly history: History;
	readonly options: ToolOptions;
	/** Items currently on a page (live array from the model). */
	getPageItems(page: number): Annotation[];
	/** Re-render the committed items layer of a page. */
	requestRender(page: number): void;
	/** Schedule a debounced save. */
	requestSave(): void;
	/** The HTML element that hosts a page (for text box editors). */
	getPageContainer(page: number): HTMLElement | null;
	/** Current zoom (CSS px per PDF unit). */
	getZoom(): number;
}

/**
 * A tool receives pointer events already associated with a page overlay.
 * Coordinates can be obtained via overlay.toPdfPoint(evt).
 */
export interface Tool {
	readonly id: ToolId;
	onActivate?(ctx: ToolContext): void;
	onDeactivate?(ctx: ToolContext): void;
	onPointerDown(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void;
	onPointerMove(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void;
	onPointerUp(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void;
	/** Key handling while the tool is active (e.g. Delete in select tool). */
	onKeyDown?(evt: KeyboardEvent, ctx: ToolContext): boolean;
}

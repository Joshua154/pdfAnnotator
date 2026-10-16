import {
	TextAnnotation,
	findAnnotation,
	generateId,
} from "../annotations/model";
import { AddCommand, UpdateCommand } from "../history";
import { PageOverlay } from "../overlay";
import { Tool, ToolContext, ToolId } from "./tool";

const DEFAULT_W = 160;
const DEFAULT_H = 28;

/**
 * Text box tool: click to place a new text box and start editing.
 * Editing uses an absolutely-positioned contenteditable div on top of
 * the page; on commit the annotation is added/updated in the model.
 */
export class TextBoxTool implements Tool {
	readonly id: ToolId = "text";

	private editor: HTMLDivElement | null = null;
	private editingExisting: TextAnnotation | null = null;
	private editingPage = 0;

	onPointerDown(
		evt: PointerEvent,
		overlay: PageOverlay,
		ctx: ToolContext
	): void {
		if (evt.button !== 0) return;
		// Commit any open editor first
		if (this.editor) {
			this.commit(ctx);
			return;
		}
		evt.preventDefault();

		// Clicking an existing text annotation re-opens it for editing
		const id = overlay.annotationIdAt(evt.target);
		if (id) {
			const ann = findAnnotation(ctx.doc, overlay.page, id);
			if (ann && ann.type === "text") {
				this.beginEdit(overlay, ctx, ann);
				return;
			}
		}

		const [x, y] = overlay.toPdfPoint(evt);
		const ann: TextAnnotation = {
			id: generateId(),
			type: "text",
			x,
			y,
			w: DEFAULT_W,
			h: DEFAULT_H * (ctx.options.fontSize / 14),
			text: "",
			color: ctx.options.textColor,
			fontSize: ctx.options.fontSize,
		};
		this.beginEdit(overlay, ctx, ann, true);
	}

	onPointerMove(): void {
		/* no-op */
	}
	onPointerUp(): void {
		/* no-op */
	}

	onDeactivate(ctx: ToolContext): void {
		if (this.editor) this.commit(ctx);
	}

	/** Also used by the select tool for double-click editing. */
	beginEdit(
		overlay: PageOverlay,
		ctx: ToolContext,
		ann: TextAnnotation,
		isNew = false
	): void {
		const container = ctx.getPageContainer(overlay.page);
		if (!container) return;

		this.editingExisting = isNew ? null : ann;
		this.editingPage = overlay.page;

		// Hide the rendered annotation while editing
		if (!isNew) {
			const el = overlay.itemsLayer.querySelector(
				`[data-ann-id="${ann.id}"]`
			);
			if (el instanceof SVGElement) el.style.display = "none";
		}

		const scale = overlay.scale;
		const editor = document.createElement("div");
		editor.className = "pdfann-textbox-editor";
		editor.contentEditable = "true";
		editor.style.left = `${ann.x * scale}px`;
		editor.style.top = `${ann.y * scale}px`;
		editor.style.width = `${ann.w * scale}px`;
		editor.style.minHeight = `${ann.h * scale}px`;
		editor.style.fontSize = `${ann.fontSize * scale}px`;
		editor.style.lineHeight = "1.25";
		editor.style.color = ann.color;
		editor.textContent = ann.text;
		container.appendChild(editor);
		this.editor = editor;

		// Save a snapshot of the annotation state for the editor commit
		const draft = ann;

		const commitHandler = () => this.commitWith(ctx, overlay, draft, scale);
		editor.addEventListener("blur", commitHandler);
		editor.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				editor.removeEventListener("blur", commitHandler);
				this.cancel(overlay, ann);
			} else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				editor.blur();
			}
			e.stopPropagation();
		});
		editor.addEventListener("pointerdown", (e) => e.stopPropagation());

		window.setTimeout(() => {
			editor.focus();
			// Place cursor at end
			const sel = window.getSelection();
			if (sel && editor.lastChild) {
				const range = document.createRange();
				range.selectNodeContents(editor);
				range.collapse(false);
				sel.removeAllRanges();
				sel.addRange(range);
			}
		}, 0);
	}

	private commitWith(
		ctx: ToolContext,
		overlay: PageOverlay,
		draft: TextAnnotation,
		scale: number
	): void {
		const editor = this.editor;
		if (!editor) return;
		this.editor = null;

		const text = (editor.innerText ?? "").replace(/\u00a0/g, " ").trimEnd();
		// Measure the editor's grown size back into PDF units
		const h = Math.max(editor.offsetHeight / scale, 10);
		const w = Math.max(editor.offsetWidth / scale, 20);
		editor.remove();

		const existing = this.editingExisting;
		this.editingExisting = null;

		if (existing) {
			// Un-hide
			const el = overlay.itemsLayer.querySelector(
				`[data-ann-id="${existing.id}"]`
			);
			if (el instanceof SVGElement) el.style.display = "";

			if (!text.trim()) {
				// Emptied out → treat as unchanged (user can delete via select/eraser)
				ctx.requestRender(overlay.page);
				return;
			}
			if (text !== existing.text || Math.abs(h - existing.h) > 1) {
				const before = existing;
				const after: TextAnnotation = {
					...existing,
					text,
					h,
				};
				ctx.history.execute(
					ctx.doc,
					new UpdateCommand(this.editingPage, before, after)
				);
				ctx.requestSave();
			} else {
				ctx.requestRender(overlay.page);
			}
			return;
		}

		// New annotation
		if (!text.trim()) return;
		const ann: TextAnnotation = { ...draft, text, w, h };
		ctx.history.execute(ctx.doc, new AddCommand(this.editingPage, ann));
		ctx.requestSave();
	}

	private commit(ctx: ToolContext): void {
		// Trigger blur → commit handler
		this.editor?.blur();
	}

	private cancel(overlay: PageOverlay, ann: TextAnnotation): void {
		this.editor?.remove();
		this.editor = null;
		this.editingExisting = null;
		// Un-hide original
		const el = overlay.itemsLayer.querySelector(
			`[data-ann-id="${ann.id}"]`
		);
		if (el instanceof SVGElement) el.style.display = "";
	}
}

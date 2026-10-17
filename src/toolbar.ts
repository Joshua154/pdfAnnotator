import { Menu, setIcon } from "obsidian";
import { RichAnnotationType, ShapeKind } from "./annotations/model";
import { ToolId, ToolOptions } from "./tools/tool";

export interface ToolbarCallbacks {
	onToolSelect(tool: ToolId): void;
	onUndo(): void;
	onRedo(): void;
	onZoomIn(): void;
	onZoomOut(): void;
	onZoomReset(): void;
	onFitWidth(): void;
	onFitHeight(): void;
	onOpenNote(): void;
	onExportPdf(): void;
	onInsertBlankPage(): void;
	onInsertRich(type: RichAnnotationType): void;
}

const PRESET_COLORS = [
	"#e03131", // red
	"#1971c2", // blue
	"#2f9e44", // green
	"#f08c00", // orange
	"#9c36b5", // purple
	"#000000", // black
	"#ffd43b", // yellow (highlighter)
	"#69db7c", // light green (highlighter)
	"#74c0fc", // light blue (highlighter)
	"#ff8787", // pink (highlighter)
];

/** Edge-style toolbar controlling tools, colors, widths, zoom, undo/redo. */
export class Toolbar {
	readonly el: HTMLElement;
	private options: ToolOptions;
	private cb: ToolbarCallbacks;

	private toolButtons = new Map<ToolId, HTMLButtonElement>();
	private shapeButtons = new Map<ShapeKind, HTMLButtonElement>();
	private colorSwatches: HTMLButtonElement[] = [];
	private undoBtn!: HTMLButtonElement;
	private redoBtn!: HTMLButtonElement;
	private insertBlankPageBtn!: HTMLButtonElement;
	private insertRichBtn!: HTMLButtonElement;
	private exportBtn!: HTMLButtonElement;
	private zoomLabel!: HTMLElement;
	private activeTool: ToolId;

	constructor(
		parent: HTMLElement,
		options: ToolOptions,
		callbacks: ToolbarCallbacks,
		defaultTool: ToolId
	) {
		this.options = options;
		this.cb = callbacks;
		this.activeTool = defaultTool;
		this.el = parent.createDiv({ cls: "pdf-annotator-toolbar" });
		this.build();
		this.setActiveTool(defaultTool);
	}

	private toolBtn(
		icon: string,
		tooltip: string,
		onClick: () => void
	): HTMLButtonElement {
		const btn = this.el.createEl("button", {
			cls: "pdfann-tool-btn",
			attr: { "aria-label": tooltip, title: tooltip },
		});
		setIcon(btn, icon);
		btn.addEventListener("click", onClick);
		return btn;
	}

	private sep(): void {
		this.el.createDiv({ cls: "pdfann-toolbar-sep" });
	}

	private build(): void {
		// --- tools ---
		const tools: [ToolId, string, string][] = [
			["select", "mouse-pointer-2", "Select / move / resize (V)"],
			["pen", "pen-line", "Pen (P)"],
			["highlighter", "highlighter", "Highlighter (H)"],
			["text", "type", "Text box (T)"],
			["eraser", "eraser", "Eraser (E)"],
			["text-highlight", "text-select", "Highlight PDF text (S)"],
		];
		for (const [id, icon, tip] of tools) {
			const btn = this.toolBtn(icon, tip, () => this.cb.onToolSelect(id));
			this.toolButtons.set(id, btn);
		}
		this.insertRichBtn = this.toolBtn("plus", "Insert LaTeX, TikZ, or Excalidraw", () => {
			const menu = new Menu();
			for (const [type, title, icon] of [
				["latex", "Insert LaTeX", "sigma"],
				["tikz", "Insert TikZ", "workflow"],
				["excalidraw", "Insert Excalidraw drawing", "pencil-ruler"],
			] as const) {
				menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(() => this.cb.onInsertRich(type)));
			}
			const rect = this.insertRichBtn.getBoundingClientRect();
			menu.showAtPosition({ x: rect.left, y: rect.bottom });
		});

		// --- shapes (each selects shape tool with a kind) ---
		this.sep();
		const shapes: [ShapeKind, string, string][] = [
			["rect", "square", "Rectangle (R)"],
			["ellipse", "circle", "Ellipse (O)"],
			["line", "minus", "Line (L)"],
			["arrow", "move-up-right", "Arrow (A)"],
		];
		for (const [kind, icon, tip] of shapes) {
			const btn = this.toolBtn(icon, tip, () => {
				this.options.shapeKind = kind;
				this.cb.onToolSelect("shape");
			});
			this.shapeButtons.set(kind, btn);
		}

		// --- colors ---
		this.sep();
		for (const color of PRESET_COLORS) {
			const swatch = this.el.createEl("button", {
				cls: "pdfann-color-swatch",
				attr: { "aria-label": color, title: color },
			});
			swatch.style.backgroundColor = color;
			swatch.addEventListener("click", () => this.pickColor(color));
			this.colorSwatches.push(swatch);
		}

		// --- stroke width ---
		this.sep();
		const widthSelect = this.el.createEl("select", {
			cls: "dropdown pdfann-width-select",
			attr: { "aria-label": "Stroke width", title: "Stroke width" },
		});
		for (const w of [1, 2, 3, 5, 8]) {
			widthSelect.createEl("option", {
				text: `${w} pt`,
				value: String(w),
			});
		}
		widthSelect.value = String(this.options.penWidth);
		widthSelect.addEventListener("change", () => {
			const w = Number(widthSelect.value);
			this.options.penWidth = w;
			this.options.highlighterWidth = w * 6;
		});

		// --- font size ---
		const fontSelect = this.el.createEl("select", {
			cls: "dropdown pdfann-fontsize-select",
			attr: { "aria-label": "Text size", title: "Text size" },
		});
		for (const s of [10, 12, 14, 18, 24, 32]) {
			fontSelect.createEl("option", {
				text: `${s} px`,
				value: String(s),
			});
		}
		fontSelect.value = String(this.options.fontSize);
		fontSelect.addEventListener("change", () => {
			this.options.fontSize = Number(fontSelect.value);
		});

		// --- undo / redo ---
		this.sep();
		this.undoBtn = this.toolBtn("undo-2", "Undo (Ctrl+Z)", () =>
			this.cb.onUndo()
		);
		this.redoBtn = this.toolBtn("redo-2", "Redo (Ctrl+Shift+Z)", () =>
			this.cb.onRedo()
		);
		this.setUndoRedoState(false, false);

		this.el.createDiv({ cls: "pdfann-toolbar-spacer" });

		// --- zoom ---
		this.toolBtn("zoom-out", "Zoom out", () => this.cb.onZoomOut());
		this.zoomLabel = this.el.createDiv({
			cls: "pdfann-zoom-label",
			text: "100%",
		});
		this.zoomLabel.addEventListener("click", () => this.cb.onZoomReset());
		this.toolBtn("zoom-in", "Zoom in", () => this.cb.onZoomIn());
		this.toolBtn("move-horizontal", "Fit width", () =>
			this.cb.onFitWidth()
		);
		this.toolBtn("move-vertical", "Fit height", () =>
			this.cb.onFitHeight()
		);

		// --- open md note ---
		this.sep();
		this.insertBlankPageBtn = this.toolBtn("file-plus", "Insert blank page after current page", () =>
			this.cb.onInsertBlankPage()
		);
		this.setInsertBlankPageEnabled(false);
		this.toolBtn("file-text", "Open annotation note", () =>
			this.cb.onOpenNote()
		);
		this.exportBtn = this.toolBtn("file-down", "Export annotated PDF", () => this.cb.onExportPdf());
		this.setExportEnabled(false);
	}

	setExportEnabled(enabled: boolean): void {
		this.exportBtn.disabled = !enabled;
	}

	setInsertBlankPageEnabled(enabled: boolean): void {
		this.insertBlankPageBtn.disabled = !enabled;
		this.insertRichBtn.disabled = !enabled;
	}

	private pickColor(color: string): void {
		if (this.activeTool === "highlighter" || this.activeTool === "text-highlight") {
			this.options.highlighterColor = color;
		} else {
			this.options.penColor = color;
			this.options.textColor = color;
		}
		this.updateColorUi();
	}

	private updateColorUi(): void {
		const active =
			this.activeTool === "highlighter" ||
			this.activeTool === "text-highlight"
				? this.options.highlighterColor
				: this.options.penColor;
		for (const sw of this.colorSwatches) {
			sw.classList.toggle(
				"is-active",
				sw.style.backgroundColor === hexToRgbCss(active) ||
					sw.getAttribute("title") === active
			);
		}
	}

	setActiveTool(tool: ToolId): void {
		this.activeTool = tool;
		for (const [id, btn] of this.toolButtons) {
			btn.classList.toggle("is-active", id === tool);
		}
		for (const [kind, btn] of this.shapeButtons) {
			btn.classList.toggle(
				"is-active",
				tool === "shape" && this.options.shapeKind === kind
			);
		}
		this.updateColorUi();
	}

	setUndoRedoState(canUndo: boolean, canRedo: boolean): void {
		this.undoBtn.disabled = !canUndo;
		this.redoBtn.disabled = !canRedo;
	}

	setZoom(zoom: number): void {
		this.zoomLabel.setText(`${Math.round(zoom * 100)}%`);
	}
}

function hexToRgbCss(hex: string): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

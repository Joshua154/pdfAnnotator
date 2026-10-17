import {
	FileView,
	Modal,
	Notice,
	Scope,
	TFile,
	ViewStateResult,
	WorkspaceLeaf,
} from "obsidian";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import {
	Annotation,
	AnnotationDocument,
	ImageAnnotation,
	createEmptyDocument,
	createBlankPage,
	documentPageOrder,
	generateId,
	getOrCreatePage,
	RichAnnotation,
	RichAnnotationType,
	findAnnotation,
} from "./annotations/model";
import { AnnotationStore } from "./annotations/store";
import { readAnnotations, writeAnnotations } from "./annotation-clipboard";
import { AddCommand, History, InsertBlankPageCommand, UpdateCommand } from "./history";
import type PdfAnnotatorPlugin from "./main";
import { PageOverlay, setImageSrcResolver } from "./overlay";
import { loadPdfDocument, renderPage } from "./pdf-renderer";
import { Toolbar } from "./toolbar";
import { pastedImagePath } from "./storage-paths";
import { PageNavigation } from "./page-navigation";
import { TouchNavigation, TouchPoint } from "./touch-navigation";
import { ExcalidrawPicker, SourceModal } from "./insert-modal";
import { mountRichContent } from "./rich-content";
import { EraserTool } from "./tools/eraser";
import { HighlighterTool } from "./tools/highlighter";
import { PenTool } from "./tools/pen";
import { SelectTool } from "./tools/select";
import { ShapeTool } from "./tools/shapes";
import { TextBoxTool } from "./tools/textbox";
import { TextHighlightTool } from "./tools/text-highlight";
import { Tool, ToolContext, ToolId, ToolOptions } from "./tools/tool";

export const VIEW_TYPE_PDF_ANNOTATOR = "pdf-annotator";

const ZOOM_LEVELS = [0.25, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

interface PageEl {
	/** Stable annotation key: positive PDF number or negative blank-page ID. */
	page: number;
	container: HTMLElement;
	canvas: HTMLCanvasElement;
	textLayer: HTMLElement;
	overlay: PageOverlay | null;
	rendered: boolean;
	renderedZoom?: number;
	pdfWidth: number;
	pdfHeight: number;
}

export class PDFAnnotatorView extends FileView {
	plugin: PdfAnnotatorPlugin;

	private pdfDoc: PDFDocumentProxy | null = null;
	private annDoc: AnnotationDocument = createEmptyDocument("");
	private noteFile: TFile | null = null;
	private store: AnnotationStore;
	private history = new History();

	private toolbar: Toolbar | null = null;
	private scrollEl: HTMLElement | null = null;
	private pageNavigation: PageNavigation | null = null;
	private touchNavigation: TouchNavigation | null = null;
	private touchZoomDirty = false;
	private queuedPages = new Set<PageEl>();
	private pageEls: PageEl[] = [];
	private zoom = 1;
	private renderQueue = Promise.resolve();
	private intersectionObserver: IntersectionObserver | null = null;

	private tools = new Map<ToolId, Tool>();
	private activeTool: Tool | null = null;
	private toolOptions: ToolOptions;
	private toolCtx: ToolContext;
	private selectTool: SelectTool;
	private textHighlightTool: TextHighlightTool;
	private insertionModal: Modal | null = null;
	private pasteTarget: { page: number; point: [number, number] } | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PdfAnnotatorPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.store = new AnnotationStore(this.app);
		this.store.autosaveDelay = plugin.settings.autosaveDelay;

		// Resolve image annotation vault paths to displayable app:// URLs
		setImageSrcResolver((src) => {
			const f = this.app.vault.getAbstractFileByPath(src);
			return f instanceof TFile
				? this.app.vault.getResourcePath(f)
				: src;
		});

		const s = plugin.settings;
		this.toolOptions = {
			penColor: s.defaultPenColor,
			penWidth: s.defaultPenWidth,
			highlighterColor: s.defaultHighlighterColor,
			highlighterWidth: s.defaultHighlighterWidth,
			shapeKind: "rect",
			fontSize: s.defaultFontSize,
			textColor: s.defaultPenColor,
		};

		// Tool context exposed to tools
		this.toolCtx = {
			doc: this.annDoc,
			history: this.history,
			options: this.toolOptions,
			getPageItems: (page) =>
				getOrCreatePage(this.annDoc, page).items,
			requestRender: (page) => this.renderOverlay(page),
			requestSave: () => this.scheduleSave(),
			getPageContainer: (page) =>
				this.pageEls.find((p) => p.page === page)?.container ?? null,
			getZoom: () => this.zoom,
			getPageOrder: () => this.pageEls.map(p => p.page),
			getPageOverlay: (page) => this.ensureOverlay(page),
			getOverlayAtPoint: (x, y) => this.overlayAtPoint(x, y),
			getScrollContainer: () => this.scrollEl,
		};

		// Instantiate tools
		const textbox = new TextBoxTool();
		this.selectTool = new SelectTool(textbox, (page, ann) => this.editRich(page, ann));
		this.textHighlightTool = new TextHighlightTool();
		this.textHighlightTool.resolveOverlay = (el) => {
			const idx = this.pageEls.findIndex((p) => p.textLayer === el);
			return idx >= 0 ? this.pageEls[idx].overlay : null;
		};
		const toolList: Tool[] = [
			this.selectTool,
			new PenTool(),
			new HighlighterTool(),
			new EraserTool(),
			textbox,
			new ShapeTool(),
			this.textHighlightTool,
		];
		for (const t of toolList) this.tools.set(t.id, t);

		this.history.onChange = (page, layoutChanged, pages) => {
			if (layoutChanged) this.syncBlankPages();
			for (const affected of pages ?? [page]) this.renderOverlay(affected);
			this.toolbar?.setUndoRedoState(
				this.history.canUndo,
				this.history.canRedo
			);
			this.selectTool.refresh(this.toolCtx);
		};
		this.registerKeyHandlers();
		this.registerClipboardHandlers();
		this.registerEvent(this.app.vault.on("modify", (file) => {
			for (const p of this.pageEls) {
				const drawings = this.annDoc.pages.get(p.page)?.items.filter(
					(ann) => ann.type === "excalidraw" && ann.source === file.path,
				) ?? [];
				for (const ann of drawings) p.overlay?.invalidateRich(ann.id);
				if (drawings.length) this.renderOverlay(p.page);
			}
		}));
	}

	getViewType(): string {
		return VIEW_TYPE_PDF_ANNOTATOR;
	}

	getDisplayText(): string {
		return this.file ? `Annotate: ${this.file.basename}` : "PDF Annotator";
	}

	getIcon(): string {
		return "pen-line";
	}

	canAcceptExtension(extension: string): boolean {
		return extension === "pdf";
	}

	// ------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------

	async onLoadFile(file: TFile): Promise<void> {
		await this.buildUi();
		try {
			this.pdfDoc = await loadPdfDocument(this.app, file);
		} catch (e) {
			console.error("PDF Annotator: failed to load PDF", e);
			new Notice("PDF Annotator: failed to load PDF");
			return;
		}

		// Load or create the annotation note
		this.noteFile = await this.store.getOrCreateNote(
			file,
			this.plugin.settings.annotationsFolder,
			this.plugin.settings.annotationsRelativeToPdf
		);
		const loaded = await this.store.load(this.noteFile, file);
		// Mutate in place so toolCtx.doc stays valid
		this.annDoc.pdfPath = loaded.pdfPath;
		this.annDoc.pages.clear();
		for (const [k, v] of loaded.pages) this.annDoc.pages.set(k, v);
		this.annDoc.blankPages = loaded.blankPages;
		this.history.clear();

		await this.buildPages();
		this.toolbar?.setInsertBlankPageEnabled(true);
		this.setTool(this.plugin.settings.defaultTool);
	}

	async onUnloadFile(file: TFile): Promise<void> {
		this.pageNavigation?.stop();
		this.deactivateTools();
		// Flush pending changes
		if (this.noteFile) {
			await this.store.saveNow(this.annDoc, this.noteFile, file);
		}
		this.teardown();
	}

	async onClose(): Promise<void> {
		this.deactivateTools();
		if (this.noteFile && this.file) {
			await this.store.saveNow(this.annDoc, this.noteFile, this.file);
		}
		this.teardown();
	}

	private deactivateTools(): void {
		this.touchNavigation?.reset();
		this.insertionModal?.close();
		this.insertionModal = null;
		// Select can also open the text editor, so deactivate every tool.
		for (const tool of this.tools.values()) tool.onDeactivate?.(this.toolCtx);
		this.activeTool = null;
	}

	private teardown(): void {
		this.deactivateTools();
		this.touchNavigation?.destroy();
		this.touchNavigation = null;
		this.touchZoomDirty = false;
		this.queuedPages.clear();
		this.store.cancelPendingSave();
		this.pageNavigation?.stop();
		this.pageNavigation = null;
		this.intersectionObserver?.disconnect();
		this.intersectionObserver = null;
		for (const p of this.pageEls) p.overlay?.destroy();
		this.pageEls = [];
		this.pasteTarget = null;
		void this.pdfDoc?.destroy().catch(() => {});
		this.pdfDoc = null;
		this.noteFile = null;
		this.contentEl.empty();
		this.toolbar = null;
		this.scrollEl = null;
	}

	async setState(
		state: Record<string, unknown>,
		result: ViewStateResult
	): Promise<void> {
		await super.setState(state, result);
	}

	// ------------------------------------------------------------------
	// UI construction
	// ------------------------------------------------------------------

	private async buildUi(): Promise<void> {
		this.pageNavigation?.stop();
		this.touchNavigation?.destroy();
		const root = this.contentEl;
		root.empty();
		root.addClass("pdf-annotator-container");

		this.toolbar = new Toolbar(root, this.toolOptions, {
			onToolSelect: (tool) => this.setTool(tool),
			onUndo: () => this.undo(),
			onRedo: () => this.redo(),
			onZoomIn: () => this.setZoom(this.nextZoom(1)),
			onZoomOut: () => this.setZoom(this.nextZoom(-1)),
			onZoomReset: () => this.setZoom(1),
			onFitWidth: () => this.fitWidth(),
			onFitHeight: () => this.fitHeight(),
			onOpenNote: () => this.openNote(),
			onInsertBlankPage: () => this.insertBlankPage(),
			onInsertRich: (type) => this.insertRich(type),
		}, this.plugin.settings.defaultTool);

		this.scrollEl = root.createDiv({ cls: "pdf-annotator-scroll" });
		this.scrollEl.tabIndex = 0;
		this.scrollEl.addEventListener("scroll", () => {
			this.pasteTarget = null;
			this.selectTool.onScroll(this.toolCtx);
		}, { passive: true });
		this.pageNavigation = new PageNavigation(
			this.scrollEl,
			() => this.pageEls.map((page) => page.container)
		);
		this.touchNavigation = new TouchNavigation(this.scrollEl, {
			shouldPan: (evt) => {
				const target = evt.target as Element;
				return this.activeTool?.id === "select" && !!target.closest(".pdf-annotator-overlay") &&
					!target.closest(".pdfann-item, .pdfann-resize-handle");
			},
			cancelTool: (evt) => {
				const svg = (evt.target as Element | null)?.closest(".pdf-annotator-overlay");
				const overlay = this.pageEls.find(p => p.overlay?.svg === svg)?.overlay;
				if (overlay) this.activeTool?.onPointerCancel?.(evt, overlay, this.toolCtx);
			},
			transform: (from, to, scale) => this.transformTouch(from, to, scale),
			finish: () => this.finishTouchZoom(),
		});
	}

	private async buildPages(): Promise<void> {
		if (!this.pdfDoc || !this.scrollEl) return;
		this.scrollEl.empty();
		this.pageEls = [];

		this.intersectionObserver?.disconnect();
		this.intersectionObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const idx = this.pageEls.findIndex(
						(p) => p.container === entry.target
					);
					if (idx >= 0 && !this.pageEls[idx].rendered) {
						this.enqueueRender(this.pageEls[idx].page);
					}
				}
			},
			{ root: this.scrollEl, rootMargin: "600px 0px" }
		);

		const numPages = this.pdfDoc.numPages;
		for (let i = 1; i <= numPages; i++) {
			const container = this.scrollEl.createDiv({
				cls: "pdf-annotator-page mode-draw",
			});
			const canvas = container.createEl("canvas");
			const textLayer = container.createDiv({
				cls: "pdf-annotator-textlayer",
			});
			const pageEl: PageEl = {
				page: i,
				container,
				canvas,
				textLayer,
				overlay: null,
				rendered: false,
				pdfWidth: 612,
				pdfHeight: 792,
			};
			this.pageEls.push(pageEl);

			// Placeholder size until rendered (use page 1's size once known)
			const page = await this.pdfDoc.getPage(i);
			const vp = page.getViewport({ scale: 1 });
			pageEl.pdfWidth = vp.width;
			pageEl.pdfHeight = vp.height;
			this.applyPageSize(pageEl);

			this.intersectionObserver.observe(container);
		}
		this.syncBlankPages();

		// Render the first pages immediately
		this.enqueueRender(1);
		if (numPages > 1) this.enqueueRender(2);
	}

	private insertBlankPage(): void {
		if (!this.pdfDoc || !this.noteFile) return;
		const currentPage = this.currentPageNum();
		const current = this.pageEls.find((p) => p.page === currentPage);
		if (!current) return;
		const tool = this.activeTool?.id ?? "pen";
		this.deactivateTools(); // Commit text edits before changing the page layout.
		const blank = createBlankPage(this.annDoc, current.page, current.pdfWidth, current.pdfHeight);
		this.history.execute(this.annDoc, new InsertBlankPageCommand(this.annDoc, blank, current.page));
		this.setTool(tool === "text-highlight" ? "pen" : tool);
		this.scheduleSave();
		this.jumpToPage(blank.page);
		this.scrollEl?.focus({ preventScroll: true });
	}

	/** Reconcile inserted paper without replacing PDF canvases or their overlays. */
	private syncBlankPages(): void {
		if (!this.pdfDoc || !this.scrollEl) return;
		this.pageNavigation?.stop();
		const order = documentPageOrder(this.annDoc, this.pdfDoc.numPages);
		const existing = new Map(this.pageEls.map((p) => [p.page, p]));
		for (const p of this.pageEls) {
			if (order.includes(p.page)) continue;
			this.intersectionObserver?.unobserve(p.container);
			p.overlay?.destroy();
			p.container.remove();
		}
		for (const blank of this.annDoc.blankPages) {
			if (existing.has(blank.page) || !order.includes(blank.page)) continue;
			const container = this.scrollEl.createDiv({ cls: "pdf-annotator-page mode-draw" });
			container.setAttribute("aria-label", `Blank annotation page after PDF page ${blank.afterPage}`);
			const p: PageEl = {
				page: blank.page,
				container,
				canvas: container.createEl("canvas"),
				textLayer: container.createDiv({ cls: "pdf-annotator-textlayer" }),
				overlay: new PageOverlay(container, blank.page, blank.width, blank.height, this.renderRich),
				rendered: true,
				pdfWidth: blank.width,
				pdfHeight: blank.height,
			};
			p.canvas.style.display = "none";
			this.applyPageSize(p);
			this.attachOverlayEvents(p.overlay!);
			this.applyToolClasses(p);
			existing.set(blank.page, p);
		}
		this.pageEls = order.map((page) => existing.get(page)!);
		for (const [index, p] of this.pageEls.entries()) {
			const child = this.scrollEl.children[index] ?? null;
			if (child !== p.container) this.scrollEl.insertBefore(p.container, child);
			if (p.page < 0) this.renderOverlay(p.page);
		}
	}

	private applyPageSize(p: PageEl): void {
		const w = Math.floor(p.pdfWidth * this.zoom);
		const h = Math.floor(p.pdfHeight * this.zoom);
		p.container.style.width = `${w}px`;
		p.container.style.height = `${h}px`;
		// Stretch the existing bitmap during a pinch; render at full resolution on release.
		p.canvas.style.width = `${w}px`;
		p.canvas.style.height = `${h}px`;
		p.textLayer.style.transform = `scale(${this.zoom / (p.renderedZoom ?? this.zoom)})`;
		p.overlay?.setDisplaySize(w, h);
	}

	private enqueueRender(pageNum: number): void {
		const page = this.pageEls.find((p) => p.page === pageNum);
		if (!page || this.queuedPages.has(page) || this.touchNavigation?.isZooming) return;
		this.queuedPages.add(page);
		this.renderQueue = this.renderQueue
			.then(() => {
				this.queuedPages.delete(page);
				if (this.pageEls.includes(page) && !this.touchNavigation?.isZooming) return this.renderPdfPage(pageNum);
			})
			.catch((e) =>
				console.error(`PDF Annotator: render page ${pageNum}`, e)
			);
	}

	private async renderPdfPage(pageNum: number): Promise<void> {
		const p = this.pageEls.find((p) => p.page === pageNum);
		if (!p || !this.pdfDoc) return;
		if (pageNum < 0) {
			this.applyPageSize(p);
			p.rendered = true;
			this.renderOverlay(pageNum);
			return;
		}

		const renderZoom = this.zoom;
		const info = await renderPage(
			this.pdfDoc,
			pageNum,
			p.canvas,
			p.textLayer,
			renderZoom
		);
		if (!this.pageEls.includes(p)) return;
		p.pdfWidth = info.pdfWidth;
		p.pdfHeight = info.pdfHeight;
		p.rendered = renderZoom === this.zoom;
		p.renderedZoom = renderZoom;
		this.applyPageSize(p);

		if (!p.overlay) {
			p.overlay = new PageOverlay(
				p.container,
				pageNum,
				info.pdfWidth,
				info.pdfHeight,
				this.renderRich
			);
			this.attachOverlayEvents(p.overlay);
			this.applyToolClasses(p);
		}
		p.overlay.setDisplaySize(
			Math.floor(info.pdfWidth * this.zoom),
			Math.floor(info.pdfHeight * this.zoom)
		);
		this.renderOverlay(pageNum);
		this.selectTool.refresh(this.toolCtx);
		if (!p.rendered) this.enqueueRender(p.page);
	}

	private renderOverlay(pageNum: number): void {
		const p = this.pageEls.find((p) => p.page === pageNum);
		if (!p?.overlay) return;
		const items = this.annDoc.pages.get(pageNum)?.items ?? [];
		p.overlay.renderItems(items);
	}

	/** Annotation interactions need not wait for lazy PDF canvas rendering. */
	private ensureOverlay(pageNum: number): PageOverlay | null {
		const p = this.pageEls.find(p => p.page === pageNum);
		if (!p) return null;
		if (!p.overlay) {
			p.overlay = new PageOverlay(p.container, p.page, p.pdfWidth, p.pdfHeight, this.renderRich);
			this.attachOverlayEvents(p.overlay);
			this.applyPageSize(p);
			this.applyToolClasses(p);
			this.renderOverlay(p.page);
		}
		return p.overlay;
	}

	private overlayAtPoint(x: number, y: number): PageOverlay | null {
		const view = this.scrollEl?.getBoundingClientRect();
		if (!view || x < view.left || x > view.right || y < view.top || y > view.bottom) return null;
		for (const p of this.pageEls) {
			const rect = p.container.getBoundingClientRect();
			if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return this.ensureOverlay(p.page);
		}
		return null;
	}

	private attachOverlayEvents(overlay: PageOverlay): void {
		const svg = overlay.svg;
		svg.addEventListener("pointerdown", (evt) => {
			if (evt.button === 0) {
				this.pasteTarget = overlay.annotationIdAt(evt.target) ? null : { page: overlay.page, point: overlay.toPdfPoint(evt) };
			}
			this.activeTool?.onPointerDown(evt, overlay, this.toolCtx);
		});
		svg.addEventListener("pointermove", (evt) => {
			this.activeTool?.onPointerMove(evt, overlay, this.toolCtx);
		});
		svg.addEventListener("pointerup", (evt) => {
			this.activeTool?.onPointerUp(evt, overlay, this.toolCtx);
		});
		svg.addEventListener("pointercancel", (evt) => {
			this.activeTool?.onPointerCancel?.(evt, overlay, this.toolCtx);
		});
		svg.addEventListener("lostpointercapture", (evt) => {
			this.activeTool?.onPointerCancel?.(evt, overlay, this.toolCtx);
		});
	}

	// ------------------------------------------------------------------
	// Tools
	// ------------------------------------------------------------------

	setTool(toolId: ToolId): void {
		const tool = this.tools.get(toolId);
		if (!tool || tool === this.activeTool) {
			this.toolbar?.setActiveTool(toolId);
			return;
		}
		this.touchNavigation?.reset();
		this.activeTool?.onDeactivate?.(this.toolCtx);
		this.activeTool = tool;
		tool.onActivate?.(this.toolCtx);
		this.toolbar?.setActiveTool(toolId);

		for (const p of this.pageEls) this.applyToolClasses(p);
	}

	private applyToolClasses(p: PageEl): void {
		const toolId = this.activeTool?.id ?? "pen";
		const isTextSelect = toolId === "text-highlight";
		p.container.classList.toggle("mode-text-select", isTextSelect);
		p.container.classList.toggle("mode-draw", !isTextSelect);
		if (p.overlay) {
			const svg = p.overlay.svg;
			svg.classList.remove(
				"tool-select",
				"tool-pen",
				"tool-highlighter",
				"tool-eraser",
				"tool-text",
				"tool-shape",
				"tool-text-highlight"
			);
			svg.classList.add(`tool-${toolId}`);
		}
	}

	private registerKeyHandlers(): void {
		if (!this.scope) this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "z", (evt) => {
			evt.preventDefault();
			this.undo();
			return false;
		});
		this.scope.register(["Mod", "Shift"], "z", (evt) => {
			evt.preventDefault();
			this.redo();
			return false;
		});
		this.scope.register(["Mod"], "y", (evt) => {
			evt.preventDefault();
			this.redo();
			return false;
		});

		// Tool shortcuts + Delete, via DOM keydown on the container
		this.contentEl.tabIndex = -1;
		this.registerDomEvent(this.contentEl, "keydown", (evt) => {
			// Don't steal keys while typing in a text editor
			const target = evt.target as HTMLElement;
			if (target.isContentEditable || target.closest("input, textarea, select")) return;

			if (this.activeTool?.onKeyDown?.(evt, this.toolCtx)) {
				evt.preventDefault();
				return;
			}
			if (evt.ctrlKey || evt.metaKey || evt.altKey ||
				(evt.shiftKey && (evt.key.startsWith("Arrow") || evt.key === "Shift"))) {
				this.pageNavigation?.stop();
				return;
			}
			if (this.pageNavigation?.handleKeyDown(evt)) {
				evt.preventDefault();
				evt.stopPropagation();
				return;
			}
			const map: Record<string, ToolId> = {
				v: "select",
				p: "pen",
				h: "highlighter",
				t: "text",
				e: "eraser",
				s: "text-highlight",
			};
			const shapeMap: Record<string, "rect" | "ellipse" | "line" | "arrow"> = {
				r: "rect",
				o: "ellipse",
				l: "line",
				a: "arrow",
			};
			const key = evt.key.toLowerCase();
			if (map[key]) {
				this.setTool(map[key]);
				evt.preventDefault();
			} else if (shapeMap[key]) {
				this.toolOptions.shapeKind = shapeMap[key];
				this.setTool("shape");
				evt.preventDefault();
			}
		});

		const doc = this.contentEl.ownerDocument;
		this.registerDomEvent(doc, "keyup", (evt) => {
			this.pageNavigation?.handleKeyUp(evt.key);
		}, true);
		this.registerDomEvent(doc.defaultView!, "blur", () => {
			this.pageNavigation?.stop();
			this.selectTool.cancelDrag(this.toolCtx);
		});
		this.registerDomEvent(doc, "visibilitychange", () => {
			if (doc.hidden) this.pageNavigation?.stop();
		});
		this.registerDomEvent(this.contentEl, "focusout", () => this.pageNavigation?.stop());
		this.registerDomEvent(this.contentEl, "wheel", () => this.pageNavigation?.stop(), { passive: true });
		this.registerDomEvent(this.contentEl, "pointerdown", (evt) => {
			this.pageNavigation?.stop();
			const target = evt.target as HTMLElement;
			if (this.scrollEl?.contains(target) && !target.isContentEditable &&
				!target.closest("input, textarea, select, button, a, [contenteditable]")) {
				this.scrollEl.focus({ preventScroll: true });
			}
		}, true); // Focus before a tool opens its own text editor.
	}

	// ------------------------------------------------------------------
	// Math and diagrams
	// ------------------------------------------------------------------

	private renderRich = (ann: RichAnnotation, container: HTMLElement): (() => void) =>
		mountRichContent(this.app, ann, container, this.noteFile?.path ?? this.file?.path ?? "");

	private insertRich(type: RichAnnotationType): void {
		if (!this.noteFile) return;
		const pageNum = this.currentPageNum();
		const page = this.pageEls.find((p) => p.page === pageNum);
		if (!page) return;
		const note = this.noteFile;
		this.deactivateTools(); // Commit text before opening a modal.
		this.setTool("select");
		const insert = (source: string) => {
			if (this.noteFile !== note || !this.pageEls.includes(page)) return;
			const w = Math.min(type === "latex" ? 240 : 300, page.pdfWidth * 0.8);
			const h = Math.min(type === "latex" ? 80 : 220, page.pdfHeight * 0.8);
			const position = this.insertionPosition(page, w, h);
			const ann: RichAnnotation = { id: generateId(), type, source, ...position, w, h };
			this.history.execute(this.annDoc, new AddCommand(page.page, ann));
			this.scheduleSave();
			this.scrollEl?.focus({ preventScroll: true });
		};
		this.insertionModal = type === "excalidraw"
			? new ExcalidrawPicker(this.app, (file) => insert(file.path))
			: new SourceModal(this.app, type, note.path, undefined, insert);
		this.insertionModal.open();
	}

	private editRich(page: number, ann: RichAnnotation): void {
		if (ann.type === "excalidraw") {
			const file = this.app.vault.getAbstractFileByPath(ann.source);
			if (file instanceof TFile) {
				void this.app.workspace.getLeaf("split").openFile(file).catch(() => new Notice("Could not open the Excalidraw drawing."));
			} else new Notice(`Drawing not found: ${ann.source}`);
			return;
		}
		const note = this.noteFile;
		if (!note) return;
		this.insertionModal?.close();
		this.insertionModal = new SourceModal(this.app, ann.type, note.path, ann.source, (source) => {
			const current = findAnnotation(this.annDoc, page, ann.id);
			if (this.noteFile !== note || !current || current.type !== ann.type || source === ann.source) return;
			this.history.execute(this.annDoc, new UpdateCommand(page, current, { ...current, source }));
			this.scheduleSave();
		});
		this.insertionModal.open();
	}

	/** Center new content in the visible part of the selected page. */
	private insertionPosition(page: PageEl, w: number, h: number): { x: number; y: number } {
		let cy = page.pdfHeight / 2;
		if (this.scrollEl) {
			const rect = page.container.getBoundingClientRect();
			const view = this.scrollEl.getBoundingClientRect();
			const top = Math.max(rect.top, view.top);
			const bottom = Math.min(rect.bottom, view.bottom);
			if (bottom > top && rect.height > 0) cy = ((top + bottom) / 2 - rect.top) / rect.height * page.pdfHeight;
		}
		return {
			x: Math.max(0, (page.pdfWidth - w) / 2),
			y: Math.max(0, Math.min(cy - h / 2, page.pdfHeight - h)),
		};
	}

	// ------------------------------------------------------------------
	// Annotation clipboard and image paste
	// ------------------------------------------------------------------

	private ownsClipboardEvent(evt: ClipboardEvent): boolean {
		if (evt.defaultPrevented || !this.noteFile || this.app.workspace.getActiveViewOfType(PDFAnnotatorView) !== this) return false;
		const target = evt.target as HTMLElement | null;
		if (target?.isContentEditable || target?.closest?.("input, textarea, select, [contenteditable], .modal-container")) return false;
		return !!target && this.contentEl.contains(target);
	}

	private registerClipboardHandlers(): void {
		const doc = this.contentEl.ownerDocument;
		for (const type of ["copy", "cut"] as const) {
			this.registerDomEvent(doc, type, (evt: ClipboardEvent) => {
				if (!this.ownsClipboardEvent(evt) || !evt.clipboardData || this.activeTool !== this.selectTool) return;
				const items = this.selectTool.copy(this.toolCtx);
				if (!writeAnnotations(evt.clipboardData, items)) return;
				evt.preventDefault();
				evt.stopPropagation();
				if (type === "cut") this.selectTool.deleteSelection(this.toolCtx);
			});
		}
		this.registerDomEvent(doc, "paste", (evt: ClipboardEvent) => {
			if (!this.ownsClipboardEvent(evt) || !evt.clipboardData) return;
			const annotations = readAnnotations(evt.clipboardData);
			if (annotations) {
				evt.preventDefault();
				evt.stopPropagation();
				const target = this.pasteTarget;
				this.setTool("select");
				if (!this.selectTool.paste(this.toolCtx, annotations, target?.page ?? this.currentPageNum(), target?.point)) {
					new Notice("PDF Annotator: not enough destination pages. Paste on an earlier page or insert blank pages first.");
				}
				return;
			}

			const items = evt.clipboardData.items;
			if (!items) return;
			for (const item of Array.from(items)) {
				if (item.kind === "file" && item.type.startsWith("image/")) {
					const blob = item.getAsFile();
					if (blob) {
						evt.preventDefault();
						void this.pasteImage(blob);
						return;
					}
				}
			}
		});
	}

	private async pasteImage(blob: File): Promise<void> {
		// Measure the image
		const objectUrl = URL.createObjectURL(blob);
		const { width: imgW, height: imgH } = await imageSize(objectUrl);
		URL.revokeObjectURL(objectUrl);
		if (!imgW || !imgH) {
			new Notice("PDF Annotator: could not read pasted image");
			return;
		}

		const pageNum = this.currentPageNum();
		const p = this.pageEls.find((p) => p.page === pageNum);
		if (!p) return;

		// Save to the configured image folder with a unique filename.
		let imageFile: TFile;
		try {
			const ext = extensionForMime(blob.type);
			const path = await pastedImagePath(
				this.app,
				this.file,
				this.noteFile?.path ?? this.file?.path ?? "",
				this.plugin.settings,
				ext
			);
			imageFile = await this.app.vault.createBinary(
				path,
				await blob.arrayBuffer()
			);
		} catch (e) {
			console.error("PDF Annotator: failed to save pasted image", e);
			new Notice("PDF Annotator: failed to save pasted image");
			return;
		}

		// Size: 96dpi px → 72pt PDF units, clamped to 60% of the page
		let w = imgW * 0.75;
		let h = imgH * 0.75;
		const maxW = p.pdfWidth * 0.6;
		const maxH = p.pdfHeight * 0.6;
		const scale = Math.min(1, maxW / w, maxH / h);
		w *= scale;
		h *= scale;

		// Position: center of the visible part of the page
		let cx = p.pdfWidth / 2;
		let cy = p.pdfHeight / 2;
		const scrollEl = this.scrollEl;
		if (scrollEl) {
			const pageRect = p.container.getBoundingClientRect();
			const viewRect = scrollEl.getBoundingClientRect();
			const visTop = Math.max(pageRect.top, viewRect.top);
			const visBottom = Math.min(pageRect.bottom, viewRect.bottom);
			if (visBottom > visTop && pageRect.height > 0) {
				const midY = (visTop + visBottom) / 2 - pageRect.top;
				cy = (midY / pageRect.height) * p.pdfHeight;
			}
		}

		const ann: ImageAnnotation = {
			id: generateId(),
			type: "image",
			x: Math.max(0, Math.min(cx - w / 2, p.pdfWidth - w)),
			y: Math.max(0, Math.min(cy - h / 2, p.pdfHeight - h)),
			w,
			h,
			src: imageFile.path,
		};
		this.history.execute(this.annDoc, new AddCommand(pageNum, ann));
		this.scheduleSave();
		// Switch to select so the image can be moved/resized right away
		this.setTool("select");
	}

	// ------------------------------------------------------------------
	// Page navigation
	// ------------------------------------------------------------------

	/** Stable annotation key of the page closest to the viewport center. */
	private currentPageNum(): number {
		const scrollEl = this.scrollEl;
		if (!scrollEl || this.pageEls.length === 0) return 1;
		const viewRect = scrollEl.getBoundingClientRect();
		const centerY = viewRect.top + viewRect.height / 2;
		let best = 1;
		let bestDist = Infinity;
		for (let i = 0; i < this.pageEls.length; i++) {
			const r = this.pageEls[i].container.getBoundingClientRect();
			const mid = r.top + r.height / 2;
			const dist = Math.abs(mid - centerY);
			if (dist < bestDist) {
				bestDist = dist;
				best = this.pageEls[i].page;
			}
		}
		return best;
	}

	/** Snap scroll so the given page starts at the top of the viewport. */
	private jumpToPage(pageNum: number): void {
		this.pageNavigation?.jumpToPage(this.pageEls.findIndex((p) => p.page === pageNum) + 1);
	}

	// ------------------------------------------------------------------
	// Undo / redo / save
	// ------------------------------------------------------------------

	private undo(): void {
		const tool = this.activeTool?.id;
		this.deactivateTools();
		if (this.history.undo(this.annDoc)) this.scheduleSave();
		if (tool) this.setTool(tool);
	}

	private redo(): void {
		const tool = this.activeTool?.id;
		this.deactivateTools();
		if (this.history.redo(this.annDoc)) this.scheduleSave();
		if (tool) this.setTool(tool);
	}

	private scheduleSave(): void {
		if (this.noteFile && this.file) {
			this.store.autosaveDelay = this.plugin.settings.autosaveDelay;
			this.store.scheduleSave(this.annDoc, this.noteFile, this.file);
		}
	}

	private async openNote(): Promise<void> {
		if (!this.noteFile) return;
		// Flush so the note is current
		if (this.file) {
			await this.store.saveNow(this.annDoc, this.noteFile, this.file);
		}
		await this.app.workspace.getLeaf("split").openFile(this.noteFile);
	}

	// ------------------------------------------------------------------
	// Zoom
	// ------------------------------------------------------------------

	private transformTouch(from: TouchPoint, to: TouchPoint, scale: number): void {
		const scroll = this.scrollEl;
		if (!scroll) return;
		this.pageNavigation?.stop();
		this.pasteTarget = null;
		const zoom = clampZoom(this.zoom * scale);
		if (Math.abs(zoom - this.zoom) < 0.0001) {
			scroll.scrollLeft += from.clientX - to.clientX;
			scroll.scrollTop += from.clientY - to.clientY;
			return;
		}

		// Anchor to a page instead of a document-height ratio: margins and page gaps
		// do not scale, and pages can have different sizes.
		let anchor: { page: PageEl; x: number; y: number } | null = null;
		let nearest = Infinity;
		for (const page of this.pageEls) {
			const rect = page.container.getBoundingClientRect();
			const distance = Math.max(rect.top - from.clientY, from.clientY - rect.bottom, 0);
			if (distance >= nearest || rect.width <= 0 || rect.height <= 0) continue;
			nearest = distance;
			anchor = { page, x: (from.clientX - rect.left) / rect.width, y: (from.clientY - rect.top) / rect.height };
		}
		if (!anchor) return;
		this.zoom = zoom;
		this.touchZoomDirty = true;
		this.toolbar?.setZoom(zoom);
		for (const page of this.pageEls) this.applyPageSize(page);
		const rect = anchor.page.container.getBoundingClientRect();
		scroll.scrollLeft += rect.left + anchor.x * rect.width - to.clientX;
		scroll.scrollTop += rect.top + anchor.y * rect.height - to.clientY;
	}

	private finishTouchZoom(): void {
		const zoomChanged = this.touchZoomDirty;
		this.touchZoomDirty = false;
		const viewport = this.scrollEl?.getBoundingClientRect();
		for (const page of this.pageEls) {
			if (page.page < 0) continue;
			if (zoomChanged) page.rendered = page.renderedZoom === this.zoom;
			const rect = page.container.getBoundingClientRect();
			if (!page.rendered && viewport && rect.bottom >= viewport.top - 600 && rect.top <= viewport.bottom + 600) {
				this.enqueueRender(page.page);
			}
		}
		if (zoomChanged) this.selectTool.refresh(this.toolCtx);
	}

	private nextZoom(dir: 1 | -1): number {
		const levels = dir === 1 ? ZOOM_LEVELS : [...ZOOM_LEVELS].reverse();
		return levels.find(level => (level - this.zoom) * dir > 0.001) ?? (dir === 1 ? MAX_ZOOM : MIN_ZOOM);
	}

	/** Zoom so the current page fills the viewport width. */
	private fitWidth(): void {
		const scrollEl = this.scrollEl;
		const pageNum = this.currentPageNum();
		const p = this.pageEls.find((p) => p.page === pageNum);
		if (!scrollEl || !p) return;
		const available = scrollEl.clientWidth - 32; // page margins
		if (available <= 0) return;
		this.setZoom(clampZoom(available / p.pdfWidth));
	}

	/** Zoom so the current page fills the viewport height. */
	private fitHeight(): void {
		const scrollEl = this.scrollEl;
		const pageNum = this.currentPageNum();
		const p = this.pageEls.find((p) => p.page === pageNum);
		if (!scrollEl || !p) return;
		const available = scrollEl.clientHeight - 32;
		if (available <= 0) return;
		this.setZoom(clampZoom(available / p.pdfHeight));
		// After zooming, snap to the page so it's fully in view
		window.requestAnimationFrame(() =>
			window.requestAnimationFrame(() => this.jumpToPage(pageNum))
		);
	}

	private setZoom(zoom: number): void {
		if (Math.abs(zoom - this.zoom) < 0.001) return;
		this.touchNavigation?.reset();
		this.pageNavigation?.stop();
		this.selectTool.cancelDrag(this.toolCtx);

		// Preserve scroll position proportionally
		const scrollEl = this.scrollEl;
		const ratio = scrollEl
			? (scrollEl.scrollTop + scrollEl.clientHeight / 2) /
			  Math.max(scrollEl.scrollHeight, 1)
			: 0;

		this.zoom = zoom;
		this.toolbar?.setZoom(zoom);

		// Resize all pages; re-render visible/rendered ones
		for (let i = 0; i < this.pageEls.length; i++) {
			const p = this.pageEls[i];
			this.applyPageSize(p);
			if (p.rendered) {
				p.rendered = false; // allow intersection observer re-render
				this.enqueueRender(p.page);
			}
		}

		if (scrollEl) {
			window.requestAnimationFrame(() => {
				scrollEl.scrollTop =
					ratio * scrollEl.scrollHeight - scrollEl.clientHeight / 2;
			});
		}
	}
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

function clampZoom(z: number): number {
	return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

function imageSize(
	url: string
): Promise<{ width: number; height: number }> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () =>
			resolve({ width: img.naturalWidth, height: img.naturalHeight });
		img.onerror = () => resolve({ width: 0, height: 0 });
		img.src = url;
	});
}

function extensionForMime(mime: string): string {
	switch (mime) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		case "image/svg+xml":
			return "svg";
		case "image/bmp":
			return "bmp";
		default:
			return "png";
	}
}


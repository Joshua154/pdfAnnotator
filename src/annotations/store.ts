import { App, Notice, TFile, normalizePath } from "obsidian";
import {
	Annotation,
	AnnotationDocument,
	BlankPage,
	createEmptyDocument,
	PageAnnotations,
} from "./model";

import { ensureStorageFolder, resolveStorageFolder } from "../storage-paths";

const CODE_FENCE_LANG = "pdf-annotations";
const FORMAT_VERSION = 2;

/**
 * Persistence layer: maps an AnnotationDocument to/from a markdown note.
 *
 * File format (per PLAN.md):
 * - YAML frontmatter with `pdf`, `plugin`, `version`
 * - Per page: `## [Page N](path#page=N)` heading, human-readable summary
 *   lines, and a ```pdf-annotations fenced JSON block (source of truth).
 */
export class AnnotationStore {
	private app: App;
	private saveTimer: number | null = null;
	private saving = false;
	private pendingSave = false;

	/** Debounce interval (ms) for autosave. */
	autosaveDelay = 1500;

	constructor(app: App) {
		this.app = app;
	}

	// ------------------------------------------------------------------
	// Path helpers
	// ------------------------------------------------------------------

	/** Markdown note path for a given PDF, inside the annotations folder. */
	notePathForPdf(pdfFile: TFile, folder: string, relativeToPdf = false): string {
		const resolved = resolveStorageFolder(pdfFile, folder, relativeToPdf);
		return normalizePath([resolved, `${pdfFile.basename}.annotations.md`].filter(Boolean).join("/"));
	}

	async getOrCreateNote(pdfFile: TFile, folder: string, relativeToPdf = false): Promise<TFile> {
		const path = this.notePathForPdf(pdfFile, folder, relativeToPdf);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;

		await ensureStorageFolder(this.app, path.split("/").slice(0, -1).join("/"));
		const doc = createEmptyDocument(pdfFile.path);
		const content = serializeDocument(doc, pdfFile, this.app);
		return await this.app.vault.create(path, content);
	}

	// ------------------------------------------------------------------
	// Load / save
	// ------------------------------------------------------------------

	async load(noteFile: TFile, pdfFile: TFile): Promise<AnnotationDocument> {
		const content = await this.app.vault.read(noteFile);
		return parseDocument(content, pdfFile.path);
	}

	/** Debounced save: call whenever the model changes. */
	scheduleSave(
		doc: AnnotationDocument,
		noteFile: TFile,
		pdfFile: TFile
	): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow(doc, noteFile, pdfFile);
		}, this.autosaveDelay);
	}

	/** Immediate save (also used on view close). */
	async saveNow(
		doc: AnnotationDocument,
		noteFile: TFile,
		pdfFile: TFile
	): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.saving) {
			this.pendingSave = true;
			return;
		}
		this.saving = true;
		try {
			const content = serializeDocument(doc, pdfFile, this.app);
			await this.app.vault.modify(noteFile, content);
		} catch (e) {
			console.error("PDF Annotator: failed to save annotations", e);
			new Notice("PDF Annotator: failed to save annotations");
		} finally {
			this.saving = false;
			if (this.pendingSave) {
				this.pendingSave = false;
				await this.saveNow(doc, noteFile, pdfFile);
			}
		}
	}

	cancelPendingSave(): void {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
	}
}

// ----------------------------------------------------------------------
// Serialization
// ----------------------------------------------------------------------

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/** Round all numbers in an annotation for compact storage. */
function compactAnnotation(ann: Annotation): Annotation {
	const a = JSON.parse(JSON.stringify(ann)) as Annotation;
	switch (a.type) {
		case "ink":
			a.points = a.points.map(
				([x, y]) => [round2(x), round2(y)] as [number, number]
			);
			a.width = round2(a.width);
			break;
		case "text":
		case "image":
			a.x = round2(a.x);
			a.y = round2(a.y);
			a.w = round2(a.w);
			a.h = round2(a.h);
			break;
		case "shape":
			a.x = round2(a.x);
			a.y = round2(a.y);
			a.x2 = round2(a.x2);
			a.y2 = round2(a.y2);
			a.width = round2(a.width);
			break;
		case "text-highlight":
			a.rects = a.rects.map((r) => ({
				x: round2(r.x),
				y: round2(r.y),
				w: round2(r.w),
				h: round2(r.h),
			}));
			break;
	}
	return a;
}

function summaryLine(ann: Annotation): string | null {
	switch (ann.type) {
		case "text": {
			const text = ann.text.replace(/\s+/g, " ").trim();
			return text ? `- Text note: "${text}"` : null;
		}
		case "text-highlight": {
			const text = ann.text.replace(/\s+/g, " ").trim();
			return text ? `- Highlight: > "${text}"` : null;
		}
		case "image":
			return ann.src.startsWith("data:")
				? `- Pasted image`
				: `- Image: ![[${ann.src}]]`;
		default:
			return null;
	}
}

function drawingSummary(items: Annotation[]): string | null {
	const pens = items.filter(
		(a) => a.type === "ink" && a.opacity >= 0.9
	).length;
	const marks = items.filter(
		(a) => a.type === "ink" && a.opacity < 0.9
	).length;
	const shapes = items.filter((a) => a.type === "shape");
	const parts: string[] = [];
	if (pens) parts.push(`${pens} pen stroke${pens > 1 ? "s" : ""}`);
	if (marks) parts.push(`${marks} highlighter stroke${marks > 1 ? "s" : ""}`);
	for (const kind of ["rect", "ellipse", "line", "arrow"] as const) {
		const n = shapes.filter((s) => s.type === "shape" && s.shape === kind)
			.length;
		if (n) parts.push(`${n} ${kind}${n > 1 ? "s" : ""}`);
	}
	return parts.length ? `- (drawing: ${parts.join(", ")})` : null;
}

export function serializeDocument(
	doc: AnnotationDocument,
	pdfFile: TFile,
	app: App
): string {
	const link = app.metadataCache.fileToLinktext(pdfFile, "");
	const lines: string[] = [];
	lines.push("---");
	lines.push(`pdf: "[[${pdfFile.path}]]"`);
	lines.push("plugin: pdf-annotator");
	lines.push(`version: ${doc.blankPages.length ? FORMAT_VERSION : 1}`);
	lines.push("---");
	lines.push(`# Annotations for ${pdfFile.name}`);
	lines.push("");

	const anchors = new Set([
		...[...doc.pages.keys()].filter((p) => p > 0),
		...doc.blankPages.map((p) => p.afterPage),
	]);
	const pageNumbers = [...anchors].sort((a, b) => a - b).flatMap((page) => [
		page, ...doc.blankPages.filter((p) => p.afterPage === page).map((p) => p.page),
	]);
	for (const pageNum of pageNumbers) {
		const blank = doc.blankPages.find((p) => p.page === pageNum);
		const page = doc.pages.get(pageNum) ?? { page: pageNum, items: [] };
		if (page.items.length === 0 && !blank) continue;

		lines.push(
			blank
				? `## Blank page ${doc.blankPages.filter((p) => p.afterPage === blank.afterPage).indexOf(blank) + 1} after PDF page ${blank.afterPage}`
				: `## [Page ${pageNum}](${encodeURI(link)}#page=${pageNum})`
		);
		lines.push("");

		// Human-readable summary lines
		const summaries: string[] = [];
		for (const ann of page.items) {
			const s = summaryLine(ann);
			if (s) summaries.push(s);
		}
		const draw = drawingSummary(page.items);
		if (draw) summaries.push(draw);
		if (summaries.length) {
			lines.push(...summaries);
			lines.push("");
		}

		// JSON block — source of truth
		const payload = {
			page: pageNum,
			...(blank ? { blankPage: { afterPage: blank.afterPage, width: blank.width, height: blank.height } } : {}),
			items: page.items.map(compactAnnotation),
		};
		lines.push("```" + CODE_FENCE_LANG);
		lines.push(JSON.stringify(payload));
		lines.push("```");
		lines.push("");
	}

	return lines.join("\n");
}

// ----------------------------------------------------------------------
// Parsing
// ----------------------------------------------------------------------

export function parseDocument(
	content: string,
	pdfPath: string
): AnnotationDocument {
	const doc = createEmptyDocument(pdfPath);
	// Find all ```pdf-annotations fenced blocks
	const fenceRe = new RegExp(
		"^```" + CODE_FENCE_LANG + "\\s*\\n([\\s\\S]*?)\\n```",
		"gm"
	);
	let m: RegExpExecArray | null;
	while ((m = fenceRe.exec(content)) !== null) {
		try {
			const payload = JSON.parse(m[1]) as {
				page: number;
				items: Annotation[];
				blankPage?: Omit<BlankPage, "page">;
			};
			if (
				!Number.isSafeInteger(payload.page) || payload.page === 0 ||
				!Array.isArray(payload.items)
			)
				continue;
			if (payload.page < 0) {
				const blank = payload.blankPage;
				if (!blank || !Number.isSafeInteger(blank.afterPage) || blank.afterPage < 1 ||
					!Number.isFinite(blank.width) || blank.width <= 0 ||
					!Number.isFinite(blank.height) || blank.height <= 0 ||
					doc.blankPages.some((p) => p.page === payload.page)) continue;
				doc.blankPages.push({ page: payload.page, afterPage: blank.afterPage, width: blank.width, height: blank.height });
			}
			const page: PageAnnotations = {
				page: payload.page,
				items: payload.items.filter(isValidAnnotation),
			};
			if (page.items.length) doc.pages.set(payload.page, page);
		} catch (e) {
			console.warn(
				"PDF Annotator: skipping malformed annotation block",
				e
			);
		}
	}
	return doc;
}

function isValidAnnotation(a: unknown): a is Annotation {
	if (!a || typeof a !== "object") return false;
	const ann = a as Partial<Annotation>;
	if (typeof ann.id !== "string") return false;
	switch (ann.type) {
		case "ink":
			return Array.isArray((ann as { points?: unknown }).points);
		case "text":
			return typeof (ann as { text?: unknown }).text === "string";
		case "shape":
			return typeof (ann as { shape?: unknown }).shape === "string";
		case "image": {
			const img = ann as { src?: unknown; dataUrl?: unknown };
			// Migrate legacy data-URL field to `src`
			if (
				typeof img.src !== "string" &&
				typeof img.dataUrl === "string"
			) {
				img.src = img.dataUrl;
				delete img.dataUrl;
			}
			return typeof img.src === "string";
		}
		case "text-highlight":
			return Array.isArray((ann as { rects?: unknown }).rects);
		default:
			return false;
	}
}

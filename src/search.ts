import type { PDFDocumentProxy, TextContent } from "pdfjs-dist/types/src/display/api";
import { AnnotationDocument, documentPageOrder } from "./annotations/model";

export type SearchScope = "all" | "pdf" | "notes";
export interface SearchMatch {
	page: number;
	kind: "pdf" | "note";
	annotationId?: string;
	start: number;
	end: number;
	snippet: string;
	/** Offsets into PDF.js textDivs, which follow text-item order. */
	segments?: { item: number; start: number; end: number }[];
}

export function textMatches(text: string, query: string): { start: number; end: number; snippet: string }[] {
	const words = query.trim().split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	const pattern = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
	return Array.from(text.matchAll(new RegExp(pattern, "giu")), match => ({
		start: match.index!,
		end: match.index! + match[0].length,
		snippet: text.slice(Math.max(0, match.index! - 35), match.index! + match[0].length + 65).replace(/\s+/g, " "),
	}));
}

export function searchPdfText(content: TextContent, page: number, query: string): SearchMatch[] {
	let text = "";
	const spans: { start: number; end: number }[] = [];
	for (const item of content.items) {
		if (!("str" in item)) continue;
		spans.push({ start: text.length, end: text.length + item.str.length });
		text += item.str + (item.hasEOL ? "\n" : "");
	}
	return textMatches(text, query).map(match => ({
		...match, page, kind: "pdf",
		segments: spans.flatMap((span, item) => span.end > span.start && span.end > match.start && span.start < match.end
			? [{ item, start: Math.max(0, match.start - span.start), end: Math.min(span.end, match.end) - span.start }]
			: []),
	}));
}

/** One cache per open document; extraction also works for pages never rendered. */
export class DocumentSearch {
	private pages = new Map<number, Promise<TextContent>>();
	private disposed = false;

	constructor(private pdf: PDFDocumentProxy) {}

	async search(doc: AnnotationDocument, query: string, scope: SearchScope, isCurrent: () => boolean):
		Promise<{ matches: SearchMatch[]; failedPages: number }> {
		const matches: SearchMatch[] = [];
		let failedPages = 0;
		if (!query.trim()) return { matches, failedPages };
		for (const page of documentPageOrder(doc, this.pdf.numPages)) {
			if (this.disposed || !isCurrent()) break;
			if (page > 0 && scope !== "notes") {
				try {
					let content = this.pages.get(page);
					if (!content) {
						content = this.pdf.getPage(page).then(p => p.getTextContent());
						this.pages.set(page, content);
					}
					const extracted = await content;
					if (this.disposed || !isCurrent()) break;
					matches.push(...searchPdfText(extracted, page, query));
				} catch {
					this.pages.delete(page); // A later search can retry a failed extraction.
					failedPages++;
				}
			}
			if (scope !== "pdf") {
				for (const ann of doc.pages.get(page)?.items ?? []) {
					const text = ann.type === "text" || ann.type === "text-highlight" ? ann.text
						: ann.type === "latex" || ann.type === "tikz" ? ann.source : "";
					if (typeof text !== "string") continue;
					matches.push(...textMatches(text, query).map(match => ({
						...match, page, kind: "note" as const, annotationId: ann.id,
					})));
				}
			}
		}
		return { matches, failedPages };
	}

	destroy(): void {
		this.disposed = true;
		this.pages.clear();
	}
}

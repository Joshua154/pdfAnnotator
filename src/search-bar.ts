import { AnnotationDocument } from "./annotations/model";
import { DocumentSearch, SearchMatch, SearchScope } from "./search";

/** View-owned find UI. Generation checks prevent late searches from changing the view. */
export class SearchBar {
	readonly el: HTMLElement;
	private input: HTMLInputElement;
	private scope: HTMLSelectElement;
	private status: HTMLElement;
	private preview: HTMLElement;
	private previous: HTMLButtonElement;
	private next: HTMLButtonElement;
	private matches: SearchMatch[] = [];
	private index = -1;
	private generation = 0;
	private timer: number | null = null;
	private win: Window;
	private failedPages = 0;
	private visible = false;
	private destroyed = false;

	constructor(
		parent: HTMLElement,
		private engine: DocumentSearch,
		private doc: AnnotationDocument,
		private navigate: (match: SearchMatch | null, scroll: boolean) => void,
		private restoreFocus: () => void,
	) {
		this.win = parent.ownerDocument.defaultView!;
		this.el = parent.createDiv({ cls: "pdfann-search", attr: { role: "search", "aria-label": "Search current PDF and notes" } });
		this.el.hidden = true;
		const row = this.el.createDiv({ cls: "pdfann-search-row" });
		this.input = row.createEl("input", { type: "search", attr: {
			placeholder: "Search PDF and notes…", "aria-label": "Search PDF and notes",
		} });
		this.scope = row.createEl("select", { attr: { "aria-label": "Search in" } });
		for (const [value, text] of [["all", "PDF and notes"], ["pdf", "PDF only"], ["notes", "Notes only"]]) {
			this.scope.createEl("option", { value, text });
		}
		this.previous = row.createEl("button", { text: "↑", attr: { "aria-label": "Previous match", title: "Previous match (Shift+Enter)" } });
		this.next = row.createEl("button", { text: "↓", attr: { "aria-label": "Next match", title: "Next match (Enter)" } });
		const close = row.createEl("button", { text: "×", attr: { "aria-label": "Close search", title: "Close search (Escape)" } });
		this.status = this.el.createDiv({ cls: "pdfann-search-status", attr: { role: "status", "aria-live": "polite" } });
		this.preview = this.el.createDiv({ cls: "pdfann-search-preview" });
		this.input.addEventListener("input", () => this.refresh());
		this.scope.addEventListener("change", () => this.refresh());
		this.previous.addEventListener("click", () => this.step(-1));
		this.next.addEventListener("click", () => this.step(1));
		close.addEventListener("click", () => this.close());
		this.el.addEventListener("keydown", evt => {
			if (evt.key === "Escape") {
				evt.preventDefault();
				this.close();
			} else if (evt.key === "Enter" && evt.target === this.input) {
				evt.preventDefault();
				this.step(evt.shiftKey ? -1 : 1);
			}
			// Tool shortcuts and annotation undo must not act on find-field input.
			evt.stopPropagation();
		});
		this.update(false);
	}

	open(): void {
		if (this.destroyed) return;
		this.visible = true;
		this.el.hidden = false;
		this.input.focus();
		this.input.select();
		this.refresh();
	}

	close(): void {
		this.visible = false;
		this.cancel();
		this.el.hidden = true;
		this.navigate(null, false);
		this.restoreFocus();
	}

	refresh(preservePosition = false): void {
		if (!this.visible || this.destroyed) return;
		const previous = preservePosition ? this.matches[this.index] : undefined;
		this.cancel();
		this.matches = [];
		this.index = -1;
		this.failedPages = 0;
		this.navigate(null, false);
		this.update(false);
		if (!this.input.value.trim()) return;
		this.status.setText("Searching…");
		const generation = this.generation;
		this.timer = this.win.setTimeout(() => {
			this.timer = null;
			void this.run(generation, previous);
		}, 150);
	}

	private async run(generation: number, previous?: SearchMatch): Promise<void> {
		const current = () => !this.destroyed && this.visible && generation === this.generation;
		try {
			const result = await this.engine.search(this.doc, this.input.value, this.scope.value as SearchScope, current);
			if (!current()) return;
			this.matches = result.matches;
			this.failedPages = result.failedPages;
			this.index = this.matches.findIndex(match => previous && match.page === previous.page &&
				match.kind === previous.kind && match.annotationId === previous.annotationId && match.start === previous.start);
			if (this.index < 0 && this.matches.length) this.index = 0;
			this.update(!previous);
		} catch {
			if (current()) this.status.setText("Search failed. Change the query to retry.");
		}
	}

	private step(direction: number): void {
		if (!this.matches.length) return;
		this.index = (this.index + direction + this.matches.length) % this.matches.length;
		this.update(true);
	}

	private update(scroll: boolean): void {
		this.previous.disabled = this.next.disabled = !this.matches.length;
		const match = this.matches[this.index];
		this.status.setText((match ? `${this.index + 1} of ${this.matches.length} matches`
			: this.input.value.trim() ? "No matches" : "Enter text to search") +
			(this.failedPages ? ` · Could not search ${this.failedPages} PDF page(s)` : ""));
		const blank = match && this.doc.blankPages.find(page => page.page === match.page);
		const label = blank ? `Blank page ${this.doc.blankPages.filter(p => p.afterPage === blank.afterPage).indexOf(blank) + 1} after PDF page ${blank.afterPage}`
			: `Page ${match?.page}`;
		this.preview.setText(match ? `${label} · ${match.kind === "pdf" ? "PDF" : "Note"}: ${match.snippet}` : "");
		this.navigate(match ?? null, scroll);
	}

	private cancel(): void {
		this.generation++;
		if (this.timer !== null) this.win.clearTimeout(this.timer);
		this.timer = null;
	}

	destroy(): void {
		this.destroyed = true;
		this.cancel();
		this.engine.destroy();
		this.el.remove();
	}
}

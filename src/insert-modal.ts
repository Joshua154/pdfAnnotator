import { App, FuzzySuggestModal, Modal, TFile } from "obsidian";
import { isExcalidrawFile, mathSource, mountRichContent, RICH_LABELS } from "./rich-content";

export type SourceType = "latex" | "tikz";

const EXAMPLES: Record<SourceType, string> = {
	latex: String.raw`E = mc^2`,
	tikz: String.raw`\begin{tikzpicture}
  \draw[->] (0,0) -- (3,0) node[right] {$x$};
  \draw[->] (0,0) -- (0,2) node[above] {$y$};
  \draw[blue, thick] (0,0) -- (2,1.5);
\end{tikzpicture}`,
};

export class SourceModal extends Modal {
	private disposePreview: (() => void) | null = null;

	constructor(
		app: App, private type: SourceType, private sourcePath: string,
		private initialSource: string | undefined, private onSubmit: (source: string) => void,
	) { super(app); }

	onOpen(): void {
		this.setTitle(`${this.initialSource === undefined ? "Insert" : "Edit"} ${RICH_LABELS[this.type]}`);
		this.modalEl.addClass("pdfann-source-modal");
		const root = this.contentEl;
		root.createEl("p", { text: this.type === "latex"
			? "Enter a LaTeX math expression. Surrounding $ or $$ delimiters are optional."
			: "Enter TikZ source. Preview requires a TikZ code-block renderer such as TikZJax. A document wrapper is added when needed." });
		const input = root.createEl("textarea", {
			cls: "pdfann-source-input", attr: { "aria-label": `${RICH_LABELS[this.type]} source`, rows: "9", spellcheck: "false" },
		});
		input.value = this.initialSource ?? EXAMPLES[this.type];
		const error = root.createDiv({ cls: "pdfann-source-error", attr: { role: "alert" } });
		const preview = root.createDiv({ cls: "pdfann-rich-viewport pdfann-source-preview" });
		const actions = root.createDiv({ cls: "pdfann-source-actions" });
		const showPreview = () => {
			this.disposePreview?.();
			this.disposePreview = mountRichContent(this.app, { type: this.type, source: input.value }, preview, this.sourcePath);
		};
		actions.createEl("button", { text: "Preview" }).addEventListener("click", showPreview);
		actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const submit = () => {
			const source = this.type === "latex" ? mathSource(input.value) : input.value.trim();
			if (!source) {
				error.textContent = "Enter source before saving.";
				input.focus();
				return;
			}
			this.onSubmit(source);
			this.close();
		};
		actions.createEl("button", {
			text: this.initialSource === undefined ? "Insert" : "Save", cls: "mod-cta",
		}).addEventListener("click", submit);
		input.addEventListener("input", () => {
			error.textContent = "";
			this.disposePreview?.();
			this.disposePreview = null;
			preview.textContent = "Select Preview to render the updated source.";
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				submit();
			}
		});
		showPreview();
		input.focus();
		input.select();
	}

	onClose(): void {
		this.disposePreview?.();
		this.disposePreview = null;
		this.contentEl.empty();
	}
}

export class ExcalidrawPicker extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onChoose: (file: TFile) => void) {
		super(app);
		this.setPlaceholder("Choose an Excalidraw drawing…");
	}
	getItems(): TFile[] { return this.app.vault.getFiles().filter((file) => isExcalidrawFile(this.app, file)); }
	getItemText(file: TFile): string { return file.path; }
	onChooseItem(file: TFile): void { this.onChoose(file); }
	onNoSuggestion(): void {
		this.resultContainerEl.empty();
		this.resultContainerEl.createDiv({ cls: "suggestion-empty", text: "No matching drawings. Create a drawing with the Excalidraw plugin, then insert it here." });
	}
}

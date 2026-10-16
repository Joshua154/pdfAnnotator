import { Menu, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_SETTINGS,
	PdfAnnotatorSettings,
	PdfAnnotatorSettingTab,
} from "./settings";
import { PDFAnnotatorView, VIEW_TYPE_PDF_ANNOTATOR } from "./view";

export default class PdfAnnotatorPlugin extends Plugin {
	settings: PdfAnnotatorSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_PDF_ANNOTATOR,
			(leaf: WorkspaceLeaf) => new PDFAnnotatorView(leaf, this)
		);

		this.addSettingTab(new PdfAnnotatorSettingTab(this.app, this));

		// Command: open the currently-active PDF in the annotator
		this.addCommand({
			id: "annotate-current-pdf",
			name: "Annotate current PDF",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "pdf") return false;
				if (!checking) void this.openAnnotator(file);
				return true;
			},
		});

		// File menu: right-click a PDF → "Annotate PDF"
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (file instanceof TFile && file.extension === "pdf") {
					menu.addItem((item) =>
						item
							.setTitle("Annotate PDF")
							.setIcon("pen-line")
							.onClick(() => void this.openAnnotator(file))
					);
				}
			})
		);
	}

	onunload(): void {
		// Obsidian detaches our views automatically on unload.
	}

	async openAnnotator(file: TFile): Promise<void> {
		if (file.extension !== "pdf") {
			new Notice("PDF Annotator: not a PDF file");
			return;
		}

		// Reuse an existing annotator leaf showing this file, if any
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_PDF_ANNOTATOR
		)) {
			// File state is available even while Obsidian defers an inactive view.
			if (leaf.getViewState().state?.file === file.path) {
				await this.app.workspace.revealLeaf(leaf);
				return;
			}
		}

		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({
			type: VIEW_TYPE_PDF_ANNOTATOR,
			state: { file: file.path },
			active: true,
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

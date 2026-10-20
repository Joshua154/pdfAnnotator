import { App, PluginSettingTab, Setting } from "obsidian";
import type PdfAnnotatorPlugin from "./main";
import { ToolId } from "./tools/tool";

export interface AnnotationFolderRule {
	/** Vault-relative source directory, including its descendants. */
	sourceFolder: string;
	/** Destination template using the global annotation base location. */
	annotationsFolder: string;
}

export interface PdfAnnotatorSettings {
	/** Folder where annotation markdown files are stored. */
	annotationsFolder: string;
	/** Resolve the annotations folder relative to each PDF's containing folder. */
	annotationsRelativeToPdf: boolean;
	annotationFolderRules: AnnotationFolderRule[];
	/** Base folder used when saving pasted images. */
	pastedImageLocation: "obsidian" | "vault" | "pdf";
	pastedImagesFolder: string;
	/** Filename template, without the extension. */
	pastedImageName: string;
	/** Default tool to use. */
	defaultTool: ToolId;
	/** Default pen color (hex). */
	defaultPenColor: string;
	/** Default highlighter color (hex). */
	defaultHighlighterColor: string;
	/** Default pen width in PDF units. */
	defaultPenWidth: number;
	/** Default highlighter width in PDF units. */
	defaultHighlighterWidth: number;
	/** Default text box font size in PDF units. */
	defaultFontSize: number;
	/** Autosave debounce in milliseconds. */
	autosaveDelay: number;
}

export const DEFAULT_SETTINGS: PdfAnnotatorSettings = {
	annotationsFolder: "PDF Annotations",
	annotationsRelativeToPdf: false,
	annotationFolderRules: [],
	pastedImageLocation: "obsidian",
	pastedImagesFolder: "PDF Images",
	pastedImageName: "Pasted image {filename} {timestamp}",
	defaultTool: "select",
	defaultPenColor: "#e03131",
	defaultHighlighterColor: "#ffd43b",
	defaultPenWidth: 2,
	defaultHighlighterWidth: 12,
	defaultFontSize: 14,
	autosaveDelay: 1500,
};

export class PdfAnnotatorSettingTab extends PluginSettingTab {
	plugin: PdfAnnotatorPlugin;

	constructor(app: App, plugin: PdfAnnotatorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const templateHelp = "Placeholders: {filename} = PDF name without extension, {folder} or {sourceDir} = PDF folder name, {sourcePath} = vault-relative PDF path including extension, {date} = YYYY-MM-DD, {time} = HH-mm-ss, {timestamp} = YYYYMMDDHHmmss; also {year}, {month}, {day}. Dates and times are local.";

		new Setting(containerEl)
			.setName("Annotations folder")
			.setDesc(
				"Folder for annotation notes, relative to the vault or PDF folder. Leave empty to use that folder directly. Use ../ for a parent folder. Applies when opening a PDF; existing notes are not moved. " + templateHelp
			)
			.addText((text) =>
				text
					.setPlaceholder("PDF Annotations/{filename}")
					.setValue(this.plugin.settings.annotationsFolder)
					.onChange(async (value) => {
						this.plugin.settings.annotationsFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Annotations relative to PDF")
			.setDesc("Resolve the annotations folder from each PDF's folder. When disabled, paths start at the vault root.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.annotationsRelativeToPdf)
					.onChange(async (value) => {
						this.plugin.settings.annotationsRelativeToPdf = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Annotation folder rules")
			.setDesc("Match a vault-relative source folder and its subfolders (case-sensitive). First match wins; otherwise use Annotations folder. Blank source folders are ignored; / matches the whole vault. Destinations support placeholders and follow Annotations relative to PDF. Existing notes are not moved.")
			.addButton(button => button.setButtonText("Add rule").onClick(async () => {
				this.plugin.settings.annotationFolderRules = [
					...this.plugin.settings.annotationFolderRules,
					{ sourceFolder: "", annotationsFolder: "" },
				];
				await this.plugin.saveSettings();
				this.display();
			}));

		this.plugin.settings.annotationFolderRules.forEach((rule, index) => {
			new Setting(containerEl)
				.setName(`Folder rule ${index + 1}`)
				.addText(text => text.setPlaceholder("Source folder: PDFs/VL")
					.setValue(rule.sourceFolder).onChange(async value => {
						rule.sourceFolder = value.trim();
						await this.plugin.saveSettings();
					}))
				.addText(text => text.setPlaceholder("Destination: Mitschriften")
					.setValue(rule.annotationsFolder).onChange(async value => {
						rule.annotationsFolder = value.trim();
						await this.plugin.saveSettings();
					}))
				.addButton(button => button.setButtonText("Move up").setDisabled(index === 0).onClick(async () => {
					const rules = this.plugin.settings.annotationFolderRules;
					[rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
					await this.plugin.saveSettings();
					this.display();
				}))
				.addButton(button => button.setButtonText("Remove").onClick(async () => {
					this.plugin.settings.annotationFolderRules.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
				}));
		});

		new Setting(containerEl)
			.setName("Pasted image location")
			.setDesc("Choose where newly pasted images are saved. Existing images are not moved.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("obsidian", "Obsidian attachment folder")
					.addOption("vault", "Relative to vault root")
					.addOption("pdf", "Relative to PDF folder")
					.setValue(this.plugin.settings.pastedImageLocation)
					.onChange(async (value) => {
						this.plugin.settings.pastedImageLocation = value as PdfAnnotatorSettings["pastedImageLocation"];
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Pasted images folder")
			.setDesc("Folder relative to the selected location. Leave empty for that folder directly; ../ selects a parent. Used with a vault or PDF location. " + templateHelp)
			.addText((text) =>
				text
					.setPlaceholder("PDF Images/{filename}")
					.setValue(this.plugin.settings.pastedImagesFolder)
					.setDisabled(this.plugin.settings.pastedImageLocation === "obsidian")
					.onChange(async (value) => {
						this.plugin.settings.pastedImagesFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Pasted image filename")
			.setDesc("Filename without folders or extension; the image extension is added automatically. Duplicate names get a numeric suffix. " + templateHelp)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.pastedImageName)
					.setValue(this.plugin.settings.pastedImageName)
					.onChange(async (value) => {
						this.plugin.settings.pastedImageName = value.trim() || DEFAULT_SETTINGS.pastedImageName;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default tool")
			.setDesc("Tool selected when opening a PDF.")
			.addDropdown((dropdown) => {
				dropdown.addOption("select", "Select");
				dropdown.addOption("pen", "Pen");
				dropdown.addOption("highlighter", "Highlighter");
				dropdown.addOption("eraser", "Eraser");
				dropdown.addOption("text", "Text");
				dropdown.addOption("shape", "Shape");
				dropdown.addOption("text-highlight", "Text Highlight");
				dropdown.setValue(this.plugin.settings.defaultTool);
				dropdown.onChange(async (value) => {
					this.plugin.settings.defaultTool = value as ToolId;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Default pen color")
			.addColorPicker((cp) =>
				cp
					.setValue(this.plugin.settings.defaultPenColor)
					.onChange(async (value) => {
						this.plugin.settings.defaultPenColor = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default highlighter color")
			.addColorPicker((cp) =>
				cp
					.setValue(this.plugin.settings.defaultHighlighterColor)
					.onChange(async (value) => {
						this.plugin.settings.defaultHighlighterColor = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default pen width")
			.setDesc("Stroke width in PDF units (points).")
			.addSlider((s) =>
				s
					.setLimits(0.5, 10, 0.5)
					.setValue(this.plugin.settings.defaultPenWidth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.defaultPenWidth = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default highlighter width")
			.setDesc("Stroke width in PDF units (points).")
			.addSlider((s) =>
				s
					.setLimits(4, 40, 1)
					.setValue(this.plugin.settings.defaultHighlighterWidth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.defaultHighlighterWidth = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default text size")
			.setDesc("Text box font size in PDF units (points).")
			.addSlider((s) =>
				s
					.setLimits(8, 48, 1)
					.setValue(this.plugin.settings.defaultFontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.defaultFontSize = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Autosave delay")
			.setDesc("Milliseconds to wait after the last change before saving.")
			.addSlider((s) =>
				s
					.setLimits(500, 5000, 100)
					.setValue(this.plugin.settings.autosaveDelay)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.autosaveDelay = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

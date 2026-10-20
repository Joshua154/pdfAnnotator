import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
	stdin: {
		contents: `export { default as PdfAnnotatorPlugin } from "./src/main";
			export { AnnotationStore } from "./src/annotations/store";
			export { fixture, TFile } from "obsidian";`,
		resolveDir: process.cwd(),
	},
	bundle: true, write: false, format: "esm",
	plugins: [{
		name: "settings-lifecycle-fixture",
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
			build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
				export const fixture = { settingsJson: '{}', loads: 0, saves: 0 };
				export class Plugin {
					constructor(app) { this.app = app; }
					async loadData() { fixture.loads++; return JSON.parse(fixture.settingsJson); }
					async saveData(settings) { fixture.saves++; fixture.settingsJson = JSON.stringify(settings); }
					registerView() {}
					addSettingTab(tab) { this.registeredSettingsTab = tab; }
					addCommand() {}
					registerEvent() {}
				}
				export class PluginSettingTab {
					constructor() {
						this.containerEl = {
							visible: false, redraws: 0, rows: [],
							isShown() { return this.visible; },
							empty() { this.rows = []; this.redraws++; },
						};
					}
				}
				class Control {
					constructor(kind) { this.kind = kind; }
					setPlaceholder() { return this; }
					setValue(value) { this.value = value; return this; }
					setDisabled() { return this; }
					setButtonText() { return this; }
					addOption() { return this; }
					setLimits() { return this; }
					setDynamicTooltip() { return this; }
					onChange(callback) { this.change = callback; return this; }
					onClick(callback) { this.click = callback; return this; }
				}
				export class Setting {
					constructor(container) { this.controls = []; container.rows.push(this); }
					setName(name) { this.name = name; return this; }
					setDesc() { return this; }
					addControl(kind, callback) {
						const control = new Control(kind);
						this.controls.push(control);
						callback(control);
						return this;
					}
					addText(callback) { return this.addControl('text', callback); }
					addToggle(callback) { return this.addControl('toggle', callback); }
					addButton(callback) { return this.addControl('button', callback); }
					addDropdown(callback) { return this.addControl('dropdown', callback); }
					addColorPicker(callback) { return this.addControl('color', callback); }
					addSlider(callback) { return this.addControl('slider', callback); }
				}
				export class Menu {}
				export class Notice {}
				export class TFolder { constructor(path) { this.path = path; } }
				export class TFile {
					constructor(path) {
						this.path = path;
						this.basename = path.split('/').pop().replace(/\\.[^.]+$/, '');
						this.parent = new TFolder(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/');
					}
				}
				export const normalizePath = path => path;
			` }));
			build.onResolve({ filter: /^\.\/view$/ }, () => ({ path: "view", namespace: "fixture-view" }));
			build.onLoad({ filter: /.*/, namespace: "fixture-view" }, () => ({ contents: `
				export class PDFAnnotatorView {}
				export const VIEW_TYPE_PDF_ANNOTATOR = 'pdf-annotator';
			` }));
		},
	}],
});
const { PdfAnnotatorPlugin, AnnotationStore, fixture, TFile } = await import(
	`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

test("externally changed persisted settings reload before routing newly opened PDFs", async () => {
	const app = { workspace: { on() {} } };
	const plugin = new PdfAnnotatorPlugin(app);
	const store = new AnnotationStore(app);
	const pdf = new TFile("26-27_WiSe/Correct-by-Construction/PDFs/Ue/Blatt 1.pdf");
	const notePath = () => store.notePathForPdf(pdf,
		plugin.settings.annotationsFolder,
		plugin.settings.annotationsRelativeToPdf,
		plugin.settings.annotationFolderRules);
	fixture.settingsJson = JSON.stringify({
		annotationsFolder: "../../Mitschriften",
		annotationsRelativeToPdf: true,
	});
	await plugin.onload();
	assert.equal(fixture.loads, 1);
	assert.equal(notePath(), "26-27_WiSe/Correct-by-Construction/Mitschriften/Blatt 1.annotations.md");
	assert.equal(plugin.settings.defaultPenWidth, 2);

	fixture.settingsJson = JSON.stringify({
		annotationsFolder: "../../Fallback",
		annotationsRelativeToPdf: true,
		annotationFolderRules: [{
			sourceFolder: "26-27_WiSe/Correct-by-Construction/PDFs/Ue",
			annotationsFolder: "../../Übung",
		}],
		defaultPenWidth: 4,
	});
	await plugin.onExternalSettingsChange();

	assert.equal(fixture.loads, 2);
	assert.equal(fixture.saves, 0);
	assert.equal(notePath(), "26-27_WiSe/Correct-by-Construction/Übung/Blatt 1.annotations.md");
	assert.equal(store.notePathForPdf(new TFile("Course/PDFs/VL/Intro.pdf"),
		plugin.settings.annotationsFolder,
		plugin.settings.annotationsRelativeToPdf,
		plugin.settings.annotationFolderRules), "Course/Fallback/Intro.annotations.md");
	assert.equal(plugin.settings.defaultPenWidth, 4);
	assert.equal(plugin.settings.defaultTool, "select");
});

test("visible settings refresh their rule controls after an external reload and save edits to current rules", async () => {
	fixture.settingsJson = JSON.stringify({
		annotationFolderRules: [{ sourceFolder: "Old/PDFs/VL", annotationsFolder: "Old notes" }],
	});
	const plugin = new PdfAnnotatorPlugin({ workspace: { on() {} } });
	await plugin.onload();
	const tab = plugin.registeredSettingsTab;
	const container = tab.containerEl;
	container.visible = true;
	tab.display();
	assert.equal(container.redraws, 1);
	const oldRule = plugin.settings.annotationFolderRules[0];

	fixture.settingsJson = JSON.stringify({
		annotationsRelativeToPdf: true,
		annotationFolderRules: [
			{ sourceFolder: "**/PDFs/Ue", annotationsFolder: "../../Übung" },
			{ sourceFolder: "**/PDFs/VL", annotationsFolder: "../../Mitschriften" },
		],
	});
	await plugin.onExternalSettingsChange();

	assert.equal(container.redraws, 2);
	const firstRule = container.rows.find(row => row.name === "Folder rule 1");
	const secondRule = container.rows.find(row => row.name === "Folder rule 2");
	assert.ok(secondRule);
	const [source, destination] = firstRule.controls.filter(control => control.kind === "text");
	assert.equal(source.value, "**/PDFs/Ue");
	assert.equal(destination.value, "../../Übung");
	await destination.change("  ../../Updated Übung  ");

	assert.equal(plugin.settings.annotationFolderRules[0].annotationsFolder, "../../Updated Übung");
	assert.equal(JSON.parse(fixture.settingsJson).annotationFolderRules[0].annotationsFolder, "../../Updated Übung");
	assert.equal(oldRule.annotationsFolder, "Old notes");
	assert.equal(new AnnotationStore({}).notePathForPdf(new TFile("Course/PDFs/Ue/Blatt 1.pdf"),
		plugin.settings.annotationsFolder,
		plugin.settings.annotationsRelativeToPdf,
		plugin.settings.annotationFolderRules), "Course/Updated Übung/Blatt 1.annotations.md");
});

test("hidden settings reload their data without redrawing until opened", async () => {
	fixture.settingsJson = JSON.stringify({
		annotationFolderRules: [{ sourceFolder: "Old", annotationsFolder: "Old notes" }],
	});
	const plugin = new PdfAnnotatorPlugin({ workspace: { on() {} } });
	await plugin.onload();
	const tab = plugin.registeredSettingsTab;
	const container = tab.containerEl;
	tab.display();
	assert.equal(container.isShown(), false);
	fixture.settingsJson = JSON.stringify({
		annotationFolderRules: [{ sourceFolder: "New", annotationsFolder: "New notes" }],
	});
	await plugin.onExternalSettingsChange();
	assert.equal(container.redraws, 1);
	assert.equal(plugin.settings.annotationFolderRules[0].sourceFolder, "New");

	container.visible = true;
	tab.display();
	const rule = container.rows.find(row => row.name === "Folder rule 1");
	assert.equal(rule.controls[0].value, "New");
	assert.equal(rule.controls[1].value, "New notes");
});

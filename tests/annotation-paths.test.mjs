import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
	stdin: {
		contents: 'export { AnnotationStore } from "./src/annotations/store"; export * from "./src/storage-paths"; export { TFile, TFolder } from "obsidian";',
		resolveDir: process.cwd(),
	},
	bundle: true, write: false, format: "esm",
	plugins: [{
		name: "obsidian-vault-fixture",
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
			build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
				export class TFolder { constructor(path) { this.path = path; } }
				export class TFile {
					constructor(path) {
						this.path = path;
						this.name = path.split('/').pop();
						this.basename = this.name.replace(/\\.[^.]+$/, '');
						this.parent = new TFolder(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/');
					}
				}
				export class Notice {}
				export const normalizePath = path => path;
			` }));
		},
	}],
});
const { AnnotationStore, TFile, TFolder, expandStorageTemplate, pastedImagePath } = await import(
	`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

test("annotation locations support vault folders, PDF folders, parents, and empty paths", () => {
	const store = new AnnotationStore({});
	const pdf = new TFile("Courses/Math/Lecture 1.pdf");
	for (const [folder, relative, expected] of [
		["PDF Annotations", false, "PDF Annotations/Lecture 1.annotations.md"],
		["PDF Annotations", true, "Courses/Math/PDF Annotations/Lecture 1.annotations.md"],
		["", true, "Courses/Math/Lecture 1.annotations.md"],
		["", false, "Lecture 1.annotations.md"],
		[".", true, "Courses/Math/Lecture 1.annotations.md"],
		["../Notes", true, "Courses/Notes/Lecture 1.annotations.md"],
		["../../Notes", true, "Notes/Lecture 1.annotations.md"],
		[" ./Notes//Drafts/../Final/ ", true, "Courses/Math/Notes/Final/Lecture 1.annotations.md"],
		["Notes\\Final", true, "Courses/Math/Notes/Final/Lecture 1.annotations.md"],
	]) {
		assert.equal(store.notePathForPdf(pdf, folder, relative), expected);
	}
	assert.equal(store.notePathForPdf(pdf, "PDF Annotations"), "PDF Annotations/Lecture 1.annotations.md");
	assert.equal(store.notePathForPdf(new TFile("Root.pdf"), "", true), "Root.annotations.md");
	assert.throws(() => store.notePathForPdf(pdf, "../../../Notes", true), /inside the vault/);
});

test("note creation uses resolved parent folders and reuses the existing note", async () => {
	const pdf = new TFile("Courses/Math/Lecture 1.pdf");
	const entries = new Map([
		["Courses", new TFolder("Courses")], ["Courses/Math", pdf.parent],
	]);
	const createdFolders = [];
	const app = {
		metadataCache: { fileToLinktext: file => file.path },
		vault: {
			getAbstractFileByPath: path => entries.get(path) ?? null,
			async createFolder(path) {
				assert.ok(entries.has(path.slice(0, path.lastIndexOf("/"))));
				const folder = new TFolder(path);
				entries.set(path, folder);
				createdFolders.push(path);
				return folder;
			},
			async create(path, content) {
				assert.match(content, /pdf: "\[\[.+\.pdf\]\]"/);
				const file = new TFile(path);
				entries.set(path, file);
				return file;
			},
		},
	};
	const store = new AnnotationStore(app);
	const note = await store.getOrCreateNote(pdf, "Notes/Nested", true);
	assert.equal(note.path, "Courses/Math/Notes/Nested/Lecture 1.annotations.md");
	assert.deepEqual(createdFolders, ["Courses/Math/Notes", "Courses/Math/Notes/Nested"]);
	assert.equal(await store.getOrCreateNote(pdf, "Notes/Nested", true), note);
	const besidePdf = await store.getOrCreateNote(pdf, "", true);
	assert.equal(besidePdf.path, "Courses/Math/Lecture 1.annotations.md");
	const atRoot = await store.getOrCreateNote(new TFile("Root.pdf"), "", true);
	assert.equal(atRoot.path, "Root.annotations.md");
	assert.equal(createdFolders.length, 2);
});

test("templates expand PDF context and local dates consistently", () => {
	const pdf = new TFile("Courses/Math/Lecture 1.pdf");
	const now = new Date(2026, 9, 16, 9, 5, 3);
	assert.equal(
		expandStorageTemplate("{filename}/{folder}/{date}/{time}/{timestamp}/{year}/{month}/{day}/{unknown}", pdf, now),
		"Lecture 1/Math/2026-10-16/09-05-03/20261016090503/2026/10/16/{unknown}"
	);
	assert.equal(new AnnotationStore({}).notePathForPdf(pdf, "Notes/{filename}", true),
		"Courses/Math/Notes/Lecture 1/Lecture 1.annotations.md");
	assert.equal(expandStorageTemplate("{folder}{filename}", new TFile("Root.pdf"), now), "Root");
});

test("source placeholders include the immediate directory and full vault-relative PDF path", () => {
	const template = "{sourceDir}|{sourcePath}|{folder}|{unknown}|{SourcePath}|{constructor}";
	assert.equal(expandStorageTemplate(template, new TFile("PDFs/Übung/Intro.pdf")),
		"Übung|PDFs/Übung/Intro.pdf|Übung|{unknown}|{SourcePath}|{constructor}");
	assert.equal(expandStorageTemplate("{sourceDir}|{sourcePath}", new TFile("Intro.pdf")), "|Intro.pdf");
	assert.equal(expandStorageTemplate("{sourceDir}|{sourcePath}", null), "|");
	assert.equal(new AnnotationStore({}).notePathForPdf(new TFile("PDFs/VL/Intro.pdf"), "Notes/{sourcePath}"),
		"Notes/PDFs/VL/Intro.pdf/Intro.annotations.md");
});

test("annotation rules route source directories, respect order, and fall back on nonmatches", () => {
	const store = new AnnotationStore({});
	const rules = [
		{ sourceFolder: "", annotationsFolder: "Ignored" },
		{ sourceFolder: "PDFs/VL/", annotationsFolder: "Mitschriften" },
		{ sourceFolder: "PDFs\\Ue", annotationsFolder: "Übung" },
		{ sourceFolder: "PDFs", annotationsFolder: "Notes/{sourceDir}" },
	];
	for (const [source, expected] of [
		["PDFs/VL/1_Intro.pdf", "Mitschriften/1_Intro.annotations.md"],
		["PDFs/Ue/2_1_FP_Origins.pdf", "Übung/2_1_FP_Origins.annotations.md"],
		["PDFs/VL/Nested/Intro.pdf", "Mitschriften/Intro.annotations.md"],
		["PDFs/VL2/Intro.pdf", "Notes/VL2/Intro.annotations.md"],
		["PDFs/vl/Intro.pdf", "Notes/vl/Intro.annotations.md"],
		["Other/Intro.pdf", "Fallback/Intro.annotations.md"],
		["Intro.pdf", "Fallback/Intro.annotations.md"],
	]) {
		assert.equal(store.notePathForPdf(new TFile(source), "Fallback", false, rules), expected);
	}
	const pdf = new TFile("PDFs/VL/Intro.pdf");
	assert.equal(store.notePathForPdf(pdf, "Fallback", true, [
		{ sourceFolder: "PDFs/VL", annotationsFolder: "../../Notes/{sourceDir}" },
	]), "Notes/VL/Intro.annotations.md");
	assert.equal(store.notePathForPdf(pdf, "Fallback", false, [
		{ sourceFolder: "/", annotationsFolder: "" },
	]), "Intro.annotations.md");
	assert.throws(() => store.notePathForPdf(pdf, "", false, [
		{ sourceFolder: "PDFs", annotationsFolder: "../Outside" },
	]), /inside the vault/);
	assert.throws(() => store.notePathForPdf(pdf, "", false, [
		{ sourceFolder: "../Outside", annotationsFolder: "Notes" },
	]), /inside the vault/);
});

test("leading **/ source rules match complete directory sequences at any depth", () => {
	const store = new AnnotationStore({});
	const rules = [
		{ sourceFolder: "**/PDFs/VL", annotationsFolder: "Mitschriften" },
		{ sourceFolder: "**/PDFs/Ue", annotationsFolder: "Übung" },
	];
	for (const [source, destination] of [
		["PDFs/VL/Intro.pdf", "Mitschriften"],
		["Course/PDFs/VL/Intro.pdf", "Mitschriften"],
		["26-27_WiSe/Correct-by-Construction/PDFs/VL/Intro.pdf", "Mitschriften"],
		["26-27_WiSe/Übersetzen/PDFs/Ue/Intro.pdf", "Übung"],
		["PDFs/Ue/Intro.pdf", "Übung"],
		["Course/PDFs/VL/Nested/Intro.pdf", "Mitschriften"],
		["Course/PDFs/Ue/Nested/More/Intro.pdf", "Übung"],
		["Course/PDFs/VL2/Intro.pdf", "Fallback"],
		["Course/OtherPDFs/VL/Intro.pdf", "Fallback"],
		["Course/PDFs/VL-extra/Intro.pdf", "Fallback"],
		["Course/PDFs/vl/Intro.pdf", "Fallback"],
		["Course/pdfs/VL/Intro.pdf", "Fallback"],
		["Course/VL/PDFs/Intro.pdf", "Fallback"],
		["Course/PDFs/Other/VL/Intro.pdf", "Fallback"],
		["Course/VL/Intro.pdf", "Fallback"],
		["Course/PDFs/Intro.pdf", "Fallback"],
		["Intro.pdf", "Fallback"],
	]) {
		assert.equal(store.notePathForPdf(new TFile(source), "Fallback", false, rules),
			`${destination}/Intro.annotations.md`, source);
	}
});

test("leading **/ rules preserve literal source anchoring and first-match order", () => {
	const store = new AnnotationStore({});
	const literal = { sourceFolder: "PDFs/VL", annotationsFolder: "Literal" };
	const specific = { sourceFolder: "**/PDFs/VL", annotationsFolder: "Specific" };
	const broad = { sourceFolder: "**/PDFs", annotationsFolder: "Broad" };
	const nested = new TFile("Course/PDFs/VL/Intro.pdf");
	assert.equal(store.notePathForPdf(nested, "Fallback", false, [literal]), "Fallback/Intro.annotations.md");
	assert.equal(store.notePathForPdf(new TFile("PDFs/VL/Intro.pdf"), "Fallback", false,
		[literal, specific]), "Literal/Intro.annotations.md");
	assert.equal(store.notePathForPdf(nested, "Fallback", false, [literal, specific]),
		"Specific/Intro.annotations.md");
	assert.equal(store.notePathForPdf(nested, "Fallback", false, [broad, specific]),
		"Broad/Intro.annotations.md");
	assert.equal(store.notePathForPdf(nested, "Fallback", false, [specific, broad]),
		"Specific/Intro.annotations.md");
});

test("leading **/ rules create and reuse course-local notes with PDF-relative destinations", async () => {
	const entries = new Map();
	let creations = 0;
	const app = {
		metadataCache: { fileToLinktext: file => file.path },
		vault: {
			getAbstractFileByPath: path => entries.get(path) ?? null,
			async createFolder(path) {
				const folder = new TFolder(path);
				entries.set(path, folder);
				return folder;
			},
			async create(path) {
				creations++;
				const file = new TFile(path);
				entries.set(path, file);
				return file;
			},
		},
	};
	const store = new AnnotationStore(app);
	const rules = [
		{ sourceFolder: "**/PDFs/VL", annotationsFolder: "../../Mitschriften" },
		{ sourceFolder: "**/PDFs/Ue", annotationsFolder: "../../Übung" },
	];
	for (const [source, destination] of [
		["26-27_WiSe/Correct-by-Construction/PDFs/VL/2_1_FP_Origins.pdf",
			"26-27_WiSe/Correct-by-Construction/Mitschriften/2_1_FP_Origins.annotations.md"],
		["26-27_WiSe/Übersetzen/PDFs/Ue/Blatt 1.pdf",
			"26-27_WiSe/Übersetzen/Übung/Blatt 1.annotations.md"],
		["26-27_WiSe/Übersetzen/PDFs/Other/Unmatched.pdf",
			"26-27_WiSe/Übersetzen/Fallback/Unmatched.annotations.md"],
	]) {
		const pdf = new TFile(source);
		assert.equal(store.notePathForPdf(pdf, "../../Fallback", true, rules), destination);
		const note = await store.getOrCreateNote(pdf, "../../Fallback", true, rules);
		assert.equal(note.path, destination);
		assert.equal(await store.getOrCreateNote(pdf, "../../Fallback", true, rules), note);
	}
	assert.equal(creations, 3);
});

test("mapped note creation and lookup use the same expanded destination", async () => {
	const entries = new Map();
	let creations = 0;
	const app = {
		metadataCache: { fileToLinktext: file => file.path },
		vault: {
			getAbstractFileByPath: path => entries.get(path) ?? null,
			async createFolder(path) {
				const folder = new TFolder(path);
				entries.set(path, folder);
				return folder;
			},
			async create(path) {
				creations++;
				const file = new TFile(path);
				entries.set(path, file);
				return file;
			},
		},
	};
	const store = new AnnotationStore(app);
	const pdf = new TFile("PDFs/Ue/Intro.pdf");
	const rules = [{ sourceFolder: "PDFs/Ue", annotationsFolder: "Übung/{sourceDir}" }];
	const note = await store.getOrCreateNote(pdf, "Fallback", false, rules);
	assert.equal(note.path, "Übung/Ue/Intro.annotations.md");
	assert.ok(entries.get("Übung/Ue") instanceof TFolder);
	assert.equal(await store.getOrCreateNote(pdf, "Fallback", false, rules), note);
	assert.equal(creations, 1);
});

test("pasted images use configured folders, expand filenames, and avoid overwrites", async () => {
	const entries = new Map();
	const app = { vault: {
		getAbstractFileByPath: path => entries.get(path) ?? null,
		async createFolder(path) {
			const folder = new TFolder(path);
			entries.set(path, folder);
			return folder;
		},
	} };
	const pdf = new TFile("Courses/Math/Lecture 1.pdf");
	const settings = {
		pastedImageLocation: "pdf", pastedImagesFolder: "../Images/{filename}",
		pastedImageName: "{filename} {date} {time}",
	};
	const now = new Date(2026, 9, 16, 9, 5, 3);
	const first = await pastedImagePath(app, pdf, "", settings, "png", now);
	assert.equal(first, "Courses/Images/Lecture 1/Lecture 1 2026-10-16 09-05-03.png");
	assert.ok(entries.get("Courses/Images/Lecture 1") instanceof TFolder);
	entries.set(first, new TFile(first));
	assert.equal(await pastedImagePath(app, pdf, "", settings, "png", now),
		"Courses/Images/Lecture 1/Lecture 1 2026-10-16 09-05-03 1.png");
	settings.pastedImagesFolder = "";
	settings.pastedImageName = "{filename}";
	assert.equal(await pastedImagePath(app, pdf, "", settings, "jpg", now), "Courses/Math/Lecture 1.jpg");
	settings.pastedImageLocation = "vault";
	assert.equal(await pastedImagePath(app, pdf, "", settings, "jpg", now), "Lecture 1.jpg");
	settings.pastedImageName = "bad/path";
	await assert.rejects(pastedImagePath(app, pdf, "", settings, "png", now), /without folders/);
});

test("Obsidian attachment mode keeps its source folder and receives the expanded filename", async () => {
	const app = { fileManager: {
		async getAvailablePathForAttachment(name, sourcePath) {
			assert.equal(name, "Lecture 1 20261016090503.png");
			assert.equal(sourcePath, "Notes/Lecture 1.annotations.md");
			return `Attachments/${name}`;
		},
	} };
	const path = await pastedImagePath(app, new TFile("Math/Lecture 1.pdf"), "Notes/Lecture 1.annotations.md", {
		pastedImageLocation: "obsidian", pastedImagesFolder: "ignored",
		pastedImageName: "{filename} {timestamp}",
	}, "png", new Date(2026, 9, 16, 9, 5, 3));
	assert.equal(path, "Attachments/Lecture 1 20261016090503.png");
});

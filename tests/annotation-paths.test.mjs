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

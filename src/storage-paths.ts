import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { AnnotationFolderRule, PdfAnnotatorSettings } from "./settings";

/** Expand storage templates using the PDF and local date/time. */
export function expandStorageTemplate(template: string, pdf: TFile | null, now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
	const values: Record<string, string> = {
		filename: pdf?.basename ?? "PDF",
		folder: pdf?.parent?.path.split("/").filter(Boolean).pop() ?? "",
		sourceDir: pdf?.parent?.path.split("/").filter(Boolean).pop() ?? "",
		sourcePath: pdf?.path ?? "",
		date,
		time,
		year: String(now.getFullYear()),
		month: pad(now.getMonth() + 1),
		day: pad(now.getDate()),
		timestamp: date.replace(/-/g, "") + time.replace(/-/g, ""),
	};
	return template.replace(/\{([a-zA-Z]+)\}/g, (match, key: string) =>
		Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match);
}

/** First matching source directory wins, including PDFs in its subdirectories. */
export function annotationFolderTemplate(pdf: TFile, fallback: string, rules: AnnotationFolderRule[] = []): string {
	const parent = (pdf.parent?.path ?? "").replace(/^\/|\/$/g, "");
	for (const rule of rules) {
		// Blank rows are inactive while the user edits settings. "/" matches the vault root.
		if (!rule.sourceFolder.trim()) continue;
		const source = resolveStorageFolder(null, rule.sourceFolder);
		if (!source || parent === source || parent.startsWith(`${source}/`)) return rule.annotationsFolder;
	}
	return fallback;
}

export function resolveStorageFolder(pdf: TFile | null, template: string, relativeToPdf = false, now = new Date()): string {
	const base = relativeToPdf ? pdf?.parent?.path ?? "" : "";
	const folder = expandStorageTemplate(template.trim(), pdf, now);
	const parts: string[] = [];
	for (const part of `${base}/${folder}`.replace(/\\/g, "/").split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!parts.length) throw new Error("Storage folder must stay inside the vault.");
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	return parts.join("/");
}

export async function ensureStorageFolder(app: App, folder: string): Promise<void> {
	const parents = folder.split("/").filter(Boolean);
	for (let i = 1; i <= parents.length; i++) {
		const path = parents.slice(0, i).join("/");
		let existing = app.vault.getAbstractFileByPath(path);
		if (!existing) {
			try {
				existing = await app.vault.createFolder(path);
			} catch (error) {
				// Another view may have created the folder in the meantime.
				existing = app.vault.getAbstractFileByPath(path);
				if (!(existing instanceof TFolder)) throw error;
			}
		}
		if (!(existing instanceof TFolder)) throw new Error(`Storage folder is a file: ${path}`);
	}
}

type ImagePathSettings = Pick<PdfAnnotatorSettings, "pastedImageLocation" | "pastedImagesFolder" | "pastedImageName">;

export async function pastedImagePath(
	app: App, pdf: TFile | null, sourcePath: string,
	settings: ImagePathSettings, extension: string, now = new Date()
): Promise<string> {
	const name = expandStorageTemplate(settings.pastedImageName.trim(), pdf, now);
	if (!name || /[/\\]/.test(name) || name === "." || name === "..") {
		throw new Error("Pasted image name must be a filename without folders.");
	}
	if (settings.pastedImageLocation === "obsidian") {
		return app.fileManager.getAvailablePathForAttachment(`${name}.${extension}`, sourcePath);
	}
	const folder = resolveStorageFolder(pdf, settings.pastedImagesFolder, settings.pastedImageLocation === "pdf", now);
	await ensureStorageFolder(app, folder);
	const prefix = folder ? `${folder}/` : "";
	let path = normalizePath(`${prefix}${name}.${extension}`);
	let suffix = 1;
	while (app.vault.getAbstractFileByPath(path)) {
		path = normalizePath(`${prefix}${name} ${suffix++}.${extension}`);
	}
	return path;
}

import {
	App, Component, MarkdownRenderer, TFile, finishRenderMath, loadMathJax, renderMath,
} from "obsidian";
import { RichAnnotation, RichAnnotationType } from "./annotations/model";

export const RICH_LABELS: Record<RichAnnotationType, string> = {
	latex: "LaTeX", tikz: "TikZ", excalidraw: "Excalidraw",
};

export function mathSource(source: string): string {
	const trimmed = source.trim();
	for (const [start, end] of [["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"]]) {
		if (trimmed.startsWith(start) && trimmed.endsWith(end) && trimmed.length >= start.length + end.length) {
			return trimmed.slice(start.length, -end.length).trim();
		}
	}
	return trimmed;
}

export function tikzMarkdown(source: string): string {
	const code = source.includes("\\begin{document}")
		? source : `\\begin{document}\n${source}\n\\end{document}`;
	const fence = "`".repeat(Math.max(3, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length + 1)));
	return `${fence}tikz\n${code}\n${fence}`;
}

export function isExcalidrawFile(app: App, file: TFile): boolean {
	return /\.excalidraw(?:\.md)?$/i.test(file.path) ||
		(file.extension === "md" && !!app.metadataCache.getFileCache(file)?.frontmatter?.["excalidraw-plugin"]);
}

/** Mount a renderer with its own lifetime, including asynchronous plugin postprocessors. */
export function mountRichContent(
	app: App, ann: Pick<RichAnnotation, "type" | "source">,
	host: HTMLElement, sourcePath: string,
): () => void {
	host.replaceChildren();
	const component = new Component();
	component.load();
	const win = host.ownerDocument.defaultView!;
	const status = host.createDiv({ cls: "pdfann-rich-status", attr: { role: "status" } });
	status.textContent = `Rendering ${RICH_LABELS[ann.type]}…`;
	const content = host.createDiv({ cls: "pdfann-rich-content" });
	content.style.visibility = "hidden";
	let disposed = false;
	let complete = false;
	let failed = false;
	let frame: number | null = null;

	const fit = () => {
		frame = null;
		if (disposed || failed) return;
		// Ignore toolbar icons and raw Markdown embeds when a renderer is absent.
		const graphic = ann.type === "excalidraw"
			? content.querySelector(".excalidraw-embedded-img")
			: ann.type === "tikz"
				? content.querySelector(".block-language-tikz")?.querySelector("svg")
				: content.querySelector("mjx-container, svg");
		if (!graphic) {
			if (complete) status.textContent = ann.type === "tikz"
				? "Waiting for TikZ. Enable a TikZ code-block renderer such as TikZJax and check the source."
				: ann.type === "excalidraw"
					? "Enable the Excalidraw plugin to display this drawing."
					: "Unable to render LaTeX. Check the expression.";
			return;
		}
		const width = content.scrollWidth;
		const height = content.scrollHeight;
		if (!width || !height || !host.clientWidth || !host.clientHeight) return;
		const scale = Math.min(Math.max(1, host.clientWidth - 8) / width, Math.max(1, host.clientHeight - 8) / height);
		const left = (host.clientWidth - width * scale) / 2;
		const top = (host.clientHeight - height * scale) / 2;
		content.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
		content.style.visibility = "visible";
		status.hidden = true;
	};
	const scheduleFit = () => {
		if (!disposed && frame === null) frame = win.requestAnimationFrame(fit);
	};
	const resize = new ResizeObserver(scheduleFit);
	resize.observe(host);
	resize.observe(content);
	// TikZ and Excalidraw may finish after MarkdownRenderer.render resolves.
	const mutations = new MutationObserver(scheduleFit);
	mutations.observe(content, { childList: true, subtree: true, characterData: true });
	content.addEventListener("load", scheduleFit, true);

	void (async () => {
		try {
			if (ann.type === "latex") {
				await loadMathJax();
				if (disposed) return;
				content.appendChild(renderMath(mathSource(ann.source), true));
				await finishRenderMath();
			} else {
				let markdown: string;
				if (ann.type === "excalidraw") {
					const file = app.vault.getAbstractFileByPath(ann.source);
					if (!(file instanceof TFile)) throw new Error(`Drawing not found: ${ann.source}`);
					markdown = "!" + app.fileManager.generateMarkdownLink(file, sourcePath, "", "600");
				} else {
					markdown = tikzMarkdown(ann.source);
				}
				await MarkdownRenderer.render(app, markdown, content, sourcePath, component);
			}
			complete = true;
			scheduleFit();
		} catch (error) {
			if (disposed) return;
			failed = true;
			status.hidden = false;
			status.textContent = `Could not render ${RICH_LABELS[ann.type]}: ${error instanceof Error ? error.message : "check the source and renderer plugin"}`;
		} finally {
			// A postprocessor may attach a child while its render promise is pending.
			if (disposed) component.unload();
		}
	})();

	return () => {
		disposed = true;
		if (frame !== null) win.cancelAnimationFrame(frame);
		resize.disconnect();
		mutations.disconnect();
		content.removeEventListener("load", scheduleFit, true);
		component.unload();
		host.replaceChildren();
	};
}

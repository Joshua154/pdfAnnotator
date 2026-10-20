// Optional real-layout regression test. No browser automation dependency is needed.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from "pdf-lib";

const browserPath = process.env.CHROMIUM_PATH;
if (!browserPath) throw new Error("Set CHROMIUM_PATH to a Chromium executable.");
const runtimeDir = resolve(process.env.PDFJS_DIR ?? "node_modules/pdfjs-dist/build");
async function runtimeFile(name) {
	for (const file of [`${name}.mjs`, `${name}.min.mjs`]) {
		try { await access(join(runtimeDir, file)); return pathToFileURL(join(runtimeDir, file)).href; } catch {}
	}
	throw new Error(`Cannot find ${name} in ${runtimeDir}`);
}
const dir = await mkdtemp(join(tmpdir(), "pdfann-text-layer-"));
let browser;
try {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	for (const userUnit of [1, 2]) for (const rotation of [0, 90, 180, 270]) {
		const page = pdf.addPage([440, 330]);
		page.setCropBox(20, 30, 400, 280);
		page.setRotation(degrees(rotation));
		page.node.set(PDFName.of("UserUnit"), PDFNumber.of(userUnit));
		page.drawText("rekursiv definiert durch", { font, size: 24, x: 50, y: 220 });
	}
	await writeFile(join(dir, "fixture.pdf"), await pdf.save());
	await build({
		entryPoints: ["tests/browser/text-layer.mjs"], bundle: true, format: "esm",
		outfile: join(dir, "test.mjs"),
		plugins: [{
			name: "obsidian-browser-fixture",
			setup(build) {
				build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
				build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
					export class FileView {} export class Scope {} export class TFile {}
					export class TFolder {} export class Notice {} export class Menu {}
					export class Modal {} export class FuzzySuggestModal {} export class Component {}
					export class MarkdownRenderer {}
					export const loadMathJax = async () => {}; export const finishRenderMath = async () => {};
					export const renderMath = () => {}; export const normalizePath = path => path;
					export const setIcon = () => {}; export const loadPdfJs = async () => globalThis.testPdfJs;
				` }));
			},
		}],
	});
	await writeFile(join(dir, "index.html"), `<!doctype html><meta charset="utf-8">
		<link rel="stylesheet" href="${pathToFileURL(resolve("styles.css")).href}">
		<style>body { margin: 0; font: 16px sans-serif; } .pdf-annotator-page { margin: 0; }</style>`);
	browser = spawn(browserPath, [
		"--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		"--allow-file-access-from-files", "--remote-debugging-pipe",
		`--user-data-dir=${join(dir, "profile")}`, "--window-size=1800,1800",
	], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
	let stderr = "", buffer = "", sequence = 0;
	const pending = new Map();
	browser.stderr.on("data", data => { stderr += data; });
	browser.on("error", error => { for (const p of pending.values()) p.reject(error); });
	browser.on("exit", code => {
		for (const p of pending.values()) p.reject(new Error(`Browser exited (${code}): ${stderr}`));
	});
	browser.stdio[4].on("data", data => {
		buffer += data;
		let end;
		while ((end = buffer.indexOf("\0")) !== -1) {
			const response = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			const request = pending.get(response.id);
			if (!request) continue;
			pending.delete(response.id);
			if (response.error) request.reject(new Error(JSON.stringify(response.error)));
			else request.resolve(response.result);
		}
	});
	function send(method, params = {}, sessionId) {
		return new Promise((resolve, reject) => {
			const id = ++sequence;
			pending.set(id, { resolve, reject });
			browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
		});
	}
	const timeout = setTimeout(() => browser.kill(), 60000);
	try {
		const { targetId } = await send("Target.createTarget", { url: pathToFileURL(join(dir, "index.html")).href });
		const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
		const options = {
			runtime: await runtimeFile("pdf"), worker: await runtimeFile("pdf.worker"),
			pdf: pathToFileURL(join(dir, "fixture.pdf")).href,
		};
		for (const deviceScaleFactor of [1, 2]) {
			await send("Emulation.setDeviceMetricsOverride", {
				width: 1800, height: 1800, deviceScaleFactor, mobile: false,
			}, sessionId);
			const result = await send("Runtime.evaluate", {
				expression: `import(${JSON.stringify(pathToFileURL(join(dir, "test.mjs")).href)}).then(m => m.run(${JSON.stringify(options)}))`,
				awaitPromise: true, returnByValue: true,
			}, sessionId);
			if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
			const { pointer, ...summary } = result.result.value;
			async function dragText() {
				await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...pointer.start }, sessionId);
				await send("Input.dispatchMouseEvent", { type: "mousePressed", ...pointer.start, button: "left", clickCount: 1 }, sessionId);
				for (let step = 1; step <= 8; step++) {
					await send("Input.dispatchMouseEvent", {
						type: "mouseMoved", button: "left", buttons: 1,
						x: pointer.start.x + (pointer.end.x - pointer.start.x) * step / 8,
						y: pointer.start.y + (pointer.end.y - pointer.start.y) * step / 8,
					}, sessionId);
				}
				await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...pointer.end, button: "left", clickCount: 1 }, sessionId);
			}
			await dragText();
			const selected = await send("Runtime.evaluate", { expression: "document.getSelection().toString()", returnByValue: true }, sessionId);
			if (selected.result.value !== pointer.text) throw new Error(`Mouse selection mismatch: ${selected.result.value}`);
			await send("Runtime.evaluate", { expression: "startHighlightProbe()" }, sessionId);
			await dragText();
			const highlighted = await send("Runtime.evaluate", {
				expression: "finishHighlightProbe()", awaitPromise: true, returnByValue: true,
			}, sessionId);
			if (highlighted.result.value !== pointer.text) throw new Error(`Mouse highlighting mismatch: ${highlighted.result.value}`);
			console.log(JSON.stringify({ deviceScaleFactor, ...summary, mouseSelectionAndHighlighting: "passed" }, null, 2));
		}
	} finally {
		clearTimeout(timeout);
	}
} finally {
	if (browser && browser.exitCode === null) {
		await new Promise(resolve => { browser.once("exit", resolve); browser.kill(); });
	}
	await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

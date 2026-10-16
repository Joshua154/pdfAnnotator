import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
// This directory contains generated release assets only.
await rm("dist", { recursive: true, force: true });
await mkdir("dist");
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	await copyFile(file, `dist/${file}`);
}
console.log(`Prepared ${manifest.id} ${manifest.version}: ${(await readdir("dist")).join(", ")}.`);

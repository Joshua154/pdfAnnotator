import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const files = ["manifest.json", "package.json", "package-lock.json", "versions.json", "README.md", "LICENSE", "styles.css"];

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "pdf-annotator-release-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await Promise.all(files.map(file => copyFile(resolve(root, file), join(directory, file))));
	const json = async file => JSON.parse(await readFile(join(directory, file), "utf8"));
	const writeJson = (file, data) => writeFile(join(directory, file), JSON.stringify(data));
	return {
		directory, json, writeJson,
		run(script, args = [], env = {}) {
			return spawnSync(process.execPath, [resolve(root, "scripts", script), ...args], {
				cwd: directory, encoding: "utf8", env: { ...process.env, ...env },
			});
		},
	};
}

test("release validation accepts matching metadata and rejects mismatched tags and versions", async t => {
	const repo = await fixture(t);
	const { version } = await repo.json("manifest.json");
	assert.equal(repo.run("check-release.mjs", [version]).status, 0);
	assert.notEqual(repo.run("check-release.mjs", [`v${version}`]).status, 0);
	const versions = await repo.json("versions.json");
	versions[version] = "0.0.1";
	await repo.writeJson("versions.json", versions);
	assert.notEqual(repo.run("check-release.mjs").status, 0);
});

test("the version hook synchronizes manifest and compatibility while preserving history", async t => {
	const repo = await fixture(t);
	const previous = await repo.json("versions.json");
	const manifest = await repo.json("manifest.json");
	const version = "0.2.0";
	const pkg = await repo.json("package.json");
	const lock = await repo.json("package-lock.json");
	pkg.version = lock.version = lock.packages[""].version = version;
	await repo.writeJson("package.json", pkg);
	await repo.writeJson("package-lock.json", lock);
	assert.equal(repo.run("version-bump.mjs", [], { npm_package_version: version }).status, 0);
	assert.equal((await repo.json("manifest.json")).version, version);
	assert.deepEqual(await repo.json("versions.json"), { ...previous, [version]: manifest.minAppVersion });
	assert.equal(repo.run("check-release.mjs", [version]).status, 0);
	assert.notEqual(repo.run("version-bump.mjs", [], { npm_package_version: "v0.3.0" }).status, 0);
});

test("release packaging includes only the three installable assets", async t => {
	const repo = await fixture(t);
	await writeFile(join(repo.directory, "main.js"), "// compiled plugin\n");
	await writeFile(join(repo.directory, "data.json"), '{"private":"settings"}');
	await mkdir(join(repo.directory, "dist"));
	await writeFile(join(repo.directory, "dist", "old-output.js"), "stale");
	assert.equal(repo.run("prepare-release.mjs").status, 0);
	assert.deepEqual((await readdir(join(repo.directory, "dist"))).sort(), ["main.js", "manifest.json", "styles.css"]);
	for (const file of ["main.js", "manifest.json", "styles.css"]) {
		assert.deepEqual(await readFile(join(repo.directory, "dist", file)), await readFile(join(repo.directory, file)));
	}
});

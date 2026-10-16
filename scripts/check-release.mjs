import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const [manifest, pkg, lock, versions] = await Promise.all([
	json("manifest.json"), json("package.json"), json("package-lock.json"), json("versions.json"),
]);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
assert.match(manifest.id, /^[a-z]+(?:-[a-z]+)*$/, "Plugin ID must contain lowercase letters and hyphens.");
assert.ok(!manifest.id.includes("obsidian") && !manifest.id.endsWith("plugin"), "Invalid plugin ID.");
for (const key of ["name", "description", "author"]) {
	assert.equal(typeof manifest[key], "string", `Missing manifest ${key}.`);
	assert.ok(manifest[key].trim(), `Manifest ${key} must not be empty.`);
}
assert.ok(!/obsidian|plugin/i.test(manifest.name), "Plugin name must not contain Obsidian or Plugin.");
assert.ok(manifest.description.length <= 250 && manifest.description.endsWith("."), "Description must end with a period and be at most 250 characters.");
assert.equal(typeof manifest.isDesktopOnly, "boolean");
assert.match(manifest.version, versionPattern, "Use a version like 1.0.0, without a v prefix.");
assert.match(manifest.minAppVersion, versionPattern);
assert.equal(pkg.version, manifest.version, "package.json and manifest.json versions differ.");
assert.equal(lock.version, manifest.version, "package-lock.json version differs.");
assert.equal(lock.packages[""].version, manifest.version, "Lockfile root version differs.");
assert.equal(versions[manifest.version], manifest.minAppVersion, "versions.json must map this version to minAppVersion.");
assert.equal(pkg.license, "MIT", "Keep package license and LICENSE in sync.");
const required = ["README.md", "LICENSE", "styles.css"];
for (const path of required) assert.ok((await readFile(path, "utf8")).trim(), `${path} must not be empty.`);
if (process.argv[2] !== undefined) {
	assert.equal(process.argv[2], manifest.version, "Release tag must equal manifest.version exactly (no v prefix).");
}
console.log(`Release metadata valid: ${manifest.id} ${manifest.version} (Obsidian ${manifest.minAppVersion}+).`);

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

// Invoked by npm version, which updates package.json and package-lock.json itself.
const version = process.env.npm_package_version;
assert.match(version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Use a plain x.y.z version.");
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));
manifest.version = version;
versions[version] = manifest.minAppVersion;
await writeFile("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");
await writeFile("versions.json", JSON.stringify(versions, null, "\t") + "\n");
console.log(`Updated manifest.json and versions.json to ${version}.`);

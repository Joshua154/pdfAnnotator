import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
	entryPoints: ["src/page-navigation.ts"], bundle: true, write: false, format: "esm",
});
const { PageNavigation } = await import(
	`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

function viewer(heights = [900, 400, 1100, 300], viewport = 600) {
	let now = 0;
	let id = 0;
	const frames = new Map();
	const win = {
		performance: { now: () => now },
		getComputedStyle: () => ({ paddingTop: "16px" }),
		requestAnimationFrame: (callback) => { frames.set(++id, callback); return id; },
		cancelAnimationFrame: (key) => frames.delete(key),
	};
	const scroll = {
		ownerDocument: { defaultView: win }, scrollTop: 0, scrollLeft: 120,
		clientHeight: viewport, clientTop: 2,
		scrollHeight: 48 + heights.reduce((sum, height) => sum + height + 16, 0),
		getBoundingClientRect: () => ({ top: 137 }),
		scrollTo({ top, behavior }) {
			assert.equal(behavior, "instant");
			this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, top));
		},
	};
	let offset = 16;
	const pages = heights.map((height) => {
		const top = offset;
		offset += height + 16;
		return { getBoundingClientRect: () => ({ top: 139 + top - scroll.scrollTop, height }) };
	});
	const navigation = new PageNavigation(scroll, () => pages);
	return {
		navigation, scroll, frames,
		key: (key, repeat = false) => navigation.handleKeyDown({ key, repeat }),
		advance(duration, interval = 10) {
			for (let elapsed = 0; elapsed < duration; elapsed += interval) {
				now += interval;
				const callbacks = [...frames.values()];
				frames.clear();
				callbacks.forEach((callback) => callback(now));
			}
		},
	};
}

test("horizontal arrows snap to consecutive page tops regardless of ancestor offsets", () => {
	const v = viewer();
	v.key("ArrowRight");
	assert.equal(v.scroll.scrollTop, 916);
	v.key("ArrowRight", true);
	assert.equal(v.scroll.scrollTop, 916, "holding Right does not skip pages");
	v.key("ArrowRight");
	assert.equal(v.scroll.scrollTop, 1332);
	v.key("ArrowLeft");
	assert.equal(v.scroll.scrollTop, 916);
	assert.equal(v.scroll.scrollLeft, 120);
	assert.equal(v.frames.size, 0);
});

test("short final pages stay selected when browser scrolling is clamped", () => {
	const v = viewer([200, 200, 200, 200], 600);
	v.key("ArrowRight");
	v.key("ArrowRight");
	v.key("ArrowRight");
	assert.equal(v.scroll.scrollTop, v.scroll.scrollHeight - 600);
	v.key("ArrowLeft"); // page 3 is also clamped at the bottom
	v.key("ArrowLeft");
	assert.equal(v.scroll.scrollTop, 216, "returns to page 2 without skipping it");
});

test("manual scrolling determines the next page from the viewport top", () => {
	const v = viewer();
	v.key("ArrowRight");
	v.scroll.scrollTop = 1500;
	v.key("ArrowLeft");
	assert.equal(v.scroll.scrollTop, 916);
	v.key("ArrowLeft");
	v.key("ArrowLeft");
	assert.equal(v.scroll.scrollTop, 0);
});

test("a tap eases forward, while a hold continues without native repeat events", () => {
	const tap = viewer();
	tap.key("ArrowDown");
	tap.navigation.handleKeyUp("ArrowDown");
	tap.advance(20);
	assert.ok(tap.scroll.scrollTop > 0 && tap.scroll.scrollTop < 48);
	tap.advance(500);
	assert.equal(tap.scroll.scrollTop, 48);
	assert.equal(tap.frames.size, 0);
	const held = viewer();
	held.key("ArrowDown");
	held.advance(500);
	assert.ok(held.scroll.scrollTop > 200);
	const before = held.scroll.scrollTop;
	held.key("ArrowDown", true);
	held.advance(500);
	assert.ok(held.scroll.scrollTop > before + 200);
	held.navigation.handleKeyUp("ArrowDown");
	held.advance(500);
	assert.equal(held.frames.size, 0);
});

test("up/down reverse, clamp to document bounds, and stop cleanly", () => {
	const v = viewer();
	v.scroll.scrollTop = 500;
	v.key("ArrowUp");
	v.advance(400);
	assert.ok(v.scroll.scrollTop < 350);
	v.key("ArrowDown");
	const before = v.scroll.scrollTop;
	v.advance(400);
	assert.ok(v.scroll.scrollTop > before);
	v.navigation.handleKeyUp("ArrowDown");
	v.advance(2000);
	assert.equal(v.scroll.scrollTop, 0);
	v.navigation.stop(); // Used on blur, wheel, pointer input, zoom and teardown.
	assert.equal(v.frames.size, 0);
	v.advance(1000);
	assert.equal(v.scroll.scrollTop, 0);
	v.key("ArrowDown");
	v.advance(100);
	v.key("ArrowRight");
	assert.equal(v.scroll.scrollTop, 916);
	assert.equal(v.frames.size, 0, "snapping cancels continuous scrolling");
});

test("resizing during a released-key animation cannot leave a runaway frame loop", () => {
	const v = viewer();
	v.scroll.scrollTop = 500;
	v.key("ArrowDown");
	v.navigation.handleKeyUp("ArrowDown");
	v.scroll.scrollHeight = 700;
	v.advance(1000);
	assert.equal(v.scroll.scrollTop, 100);
	assert.equal(v.frames.size, 0);
});

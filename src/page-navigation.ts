/** Keyboard navigation in scroll-container coordinates, independent of layout offsets. */
export class PageNavigation {
	private readonly win: Window;
	private frame: number | null = null;
	private held = new Set<string>();
	private target = 0;
	private lastTime = 0;
	private holdStart = 0;
	private snapped: { page: number; top: number } | null = null;

	constructor(
		private readonly scrollEl: HTMLElement,
		private readonly pages: () => HTMLElement[]
	) {
		this.win = scrollEl.ownerDocument.defaultView!;
	}

	handleKeyDown(evt: KeyboardEvent): boolean {
		if (evt.key === "ArrowLeft" || evt.key === "ArrowRight") {
			// A held horizontal arrow must not race through the document.
			if (!evt.repeat) {
				this.jumpToPage(this.currentPage() + (evt.key === "ArrowLeft" ? -1 : 1));
			}
			return true;
		}
		if (evt.key !== "ArrowUp" && evt.key !== "ArrowDown") return false;
		// The animation loop supplies repetition without restarting browser animations.
		if (evt.repeat || this.held.has(evt.key)) return true;
		this.held.add(evt.key);
		this.snapped = null;
		const now = this.win.performance.now();
		this.holdStart = now;
		this.target = this.clamp(this.scrollEl.scrollTop + this.direction() * 48);
		this.start(now);
		return true;
	}

	handleKeyUp(key: string): void {
		if (!this.held.delete(key)) return;
		if (this.held.size) {
			this.target = this.scrollEl.scrollTop;
			this.start(this.win.performance.now());
		}
	}

	jumpToPage(page: number): void {
		this.stop();
		const pages = this.pages();
		page = Math.max(1, Math.min(pages.length, page));
		const element = pages[page - 1];
		if (!element) return;
		const top = this.clamp(this.pageTop(element) - this.paddingTop());
		this.scrollEl.scrollTo({ top, behavior: "instant" });
		// Retain the selected page even when the last page cannot reach the top.
		this.snapped = { page, top: this.scrollEl.scrollTop };
	}

	stop(): void {
		if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
		this.frame = null;
		this.held.clear();
		this.snapped = null;
	}

	private currentPage(): number {
		if (this.snapped && Math.abs(this.scrollEl.scrollTop - this.snapped.top) < 1) {
			return this.snapped.page;
		}
		const anchor = this.scrollEl.scrollTop + this.paddingTop() + 1;
		const pages = this.pages();
		let page = 1;
		for (let i = 0; i < pages.length; i++) {
			if (this.pageTop(pages[i]) > anchor) break;
			page = i + 1;
		}
		return page;
	}

	private pageTop(page: HTMLElement): number {
		return this.scrollEl.scrollTop + page.getBoundingClientRect().top -
			this.scrollEl.getBoundingClientRect().top - this.scrollEl.clientTop;
	}

	private paddingTop(): number {
		return parseFloat(this.win.getComputedStyle(this.scrollEl).paddingTop) || 0;
	}

	private clamp(top: number): number {
		return Math.max(0, Math.min(this.scrollEl.scrollHeight - this.scrollEl.clientHeight, top));
	}

	private direction(): number {
		const keys = Array.from(this.held);
		return keys[keys.length - 1] === "ArrowUp" ? -1 : 1;
	}

	private start(now: number): void {
		if (this.frame !== null) return;
		this.lastTime = now;
		this.frame = this.win.requestAnimationFrame(this.tick);
	}

	private tick = (now: number): void => {
		const elapsed = Math.min(now - this.lastTime, 32);
		this.lastTime = now;
		if (this.held.size && now - this.holdStart >= 120) {
			// One viewport per second, with sensible bounds at small/large window sizes.
			const speed = Math.max(300, Math.min(1000, this.scrollEl.clientHeight));
			this.target = this.clamp(this.target + this.direction() * speed * elapsed / 1000);
		}
		this.target = this.clamp(this.target);
		const remaining = this.target - this.scrollEl.scrollTop;
		const top = Math.abs(remaining) < 1
			? this.target
			: this.scrollEl.scrollTop + remaining * (1 - Math.exp(-elapsed / 45));
		this.scrollEl.scrollTo({ top, behavior: "instant" });
		if (!this.held.size && Math.abs(this.target - this.scrollEl.scrollTop) < 1) {
			this.scrollEl.scrollTo({ top: this.target, behavior: "instant" });
			this.frame = null;
			return;
		}
		this.frame = this.win.requestAnimationFrame(this.tick);
	};
}

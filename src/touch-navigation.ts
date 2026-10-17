export interface TouchPoint { clientX: number; clientY: number }

interface TouchNavigationOptions {
	/** One finger pans empty space in Select; annotation hits still reach the tool. */
	shouldPan(evt: PointerEvent): boolean;
	/** Cancel the original tool gesture before taking over with two fingers. */
	cancelTool(evt: PointerEvent): void;
	transform(from: TouchPoint, to: TouchPoint, scale: number): void;
	finish(): void;
}

/** Touch navigation shared by every page, including captured annotation drags. */
export class TouchNavigation {
	private pointers = new Map<number, PointerEvent>();
	private navigating = false;
	private zooming = false;
	private frame: number | null = null;
	private velocity = { x: 0, y: 0 };
	private lastMoveTime = 0;
	private win: Window;
	private doc: Document;

	constructor(private scroll: HTMLElement, private options: TouchNavigationOptions) {
		this.doc = scroll.ownerDocument;
		this.win = this.doc.defaultView!;
		scroll.addEventListener("pointerdown", this.onDown, true);
		// Pointer-event cancellation alone cannot suppress native scrolling on text
		// layers/page gaps, which also support ordinary one-finger browser scrolling.
		scroll.addEventListener("touchstart", this.onNativeTouch, { passive: false });
		scroll.addEventListener("touchmove", this.onNativeTouch, { passive: false });
		scroll.addEventListener("wheel", this.onWheel, { passive: true });
		scroll.addEventListener("lostpointercapture", this.onLostCapture);
		// Document capture runs before the SVG's captured tool events, even off-page.
		this.doc.addEventListener("pointermove", this.onMove, { capture: true, passive: false });
		this.doc.addEventListener("pointerup", this.onUp, true);
		this.doc.addEventListener("pointercancel", this.onCancel, true);
		this.win.addEventListener("blur", this.onBlur);
		this.doc.addEventListener("visibilitychange", this.onVisibilityChange);
	}

	get isZooming(): boolean { return this.zooming; }

	private onDown = (evt: PointerEvent): void => {
		this.stopMomentum();
		if (evt.pointerType !== "touch" || evt.button !== 0) return;
		const target = evt.target as Element | null;
		if (target?.closest("input, textarea, select, button, a, [contenteditable]")) return;
		this.pointers.set(evt.pointerId, evt);
		this.velocity = { x: 0, y: 0 };
		this.lastMoveTime = evt.timeStamp;
		if (this.pointers.size === 1) {
			this.navigating = this.options.shouldPan(evt);
			if (this.navigating) {
				this.scroll.setPointerCapture(evt.pointerId);
				// Let Select receive the initial tap to clear its selection.
				evt.preventDefault();
			}
			return;
		}
		if (!this.zooming) {
			this.zooming = true;
			for (const pointer of this.pointers.values()) this.options.cancelTool(pointer);
		}
		this.navigating = true;
		for (const id of this.pointers.keys()) this.scroll.setPointerCapture(id);
		this.consume(evt);
	};

	private onMove = (evt: PointerEvent): void => {
		if (!this.pointers.has(evt.pointerId)) return;
		const before = [...this.pointers.values()];
		this.pointers.set(evt.pointerId, evt);
		if (!this.navigating) return;
		this.consume(evt);
		const after = [...this.pointers.values()];
		const from = midpoint(before), to = midpoint(after);
		const oldDistance = distance(before), newDistance = distance(after);
		const scale = oldDistance > 0 && newDistance > 0 ? newDistance / oldDistance : 1;
		this.options.transform(from, to, scale);
		const elapsed = evt.timeStamp - this.lastMoveTime;
		if (elapsed > 0) {
			this.velocity = { x: (from.clientX - to.clientX) / Math.max(elapsed, 8), y: (from.clientY - to.clientY) / Math.max(elapsed, 8) };
		}
		this.lastMoveTime = evt.timeStamp;
	};

	private onUp = (evt: PointerEvent): void => {
		if (!this.pointers.has(evt.pointerId)) return;
		const navigating = this.navigating;
		this.pointers.delete(evt.pointerId);
		if (!navigating) return;
		this.consume(evt);
		this.release(evt.pointerId);
		// A remaining finger keeps panning; it must never resume the canceled tool.
		if (this.pointers.size) {
			this.velocity = { x: 0, y: 0 };
			this.lastMoveTime = evt.timeStamp;
			return;
		}
		const wasZooming = this.zooming;
		this.navigating = false;
		this.zooming = false;
		this.options.finish();
		if (!wasZooming && evt.timeStamp - this.lastMoveTime < 80) this.startMomentum();
	};

	private onCancel = (evt: PointerEvent): void => {
		if (!this.pointers.has(evt.pointerId)) return;
		if (this.navigating) this.consume(evt);
		// Canceling one contact ends navigation, including any other captured fingers.
		this.reset();
	};

	private onBlur = (): void => this.reset();
	private onWheel = (): void => this.stopMomentum();
	private onLostCapture = (evt: PointerEvent): void => {
		if (evt.target === this.scroll && this.pointers.has(evt.pointerId)) this.reset();
	};
	private onVisibilityChange = (): void => { if (this.doc.hidden) this.reset(); };
	private onNativeTouch = (evt: TouchEvent): void => {
		if (this.navigating) {
			evt.preventDefault();
			evt.stopPropagation();
		}
	};

	private consume(evt: PointerEvent): void {
		evt.preventDefault();
		evt.stopImmediatePropagation();
	}

	private release(id: number): void {
		if (this.scroll.hasPointerCapture(id)) this.scroll.releasePointerCapture(id);
	}

	private startMomentum(): void {
		let previous = this.win.performance.now();
		const tick = (time: number) => {
			this.frame = null;
			const elapsed = Math.min(time - previous, 32);
			previous = time;
			const left = this.scroll.scrollLeft, top = this.scroll.scrollTop;
			this.scroll.scrollLeft += this.velocity.x * elapsed;
			this.scroll.scrollTop += this.velocity.y * elapsed;
			const decay = Math.exp(-elapsed / 180);
			this.velocity.x = this.scroll.scrollLeft === left ? 0 : this.velocity.x * decay;
			this.velocity.y = this.scroll.scrollTop === top ? 0 : this.velocity.y * decay;
			if (Math.hypot(this.velocity.x, this.velocity.y) > 0.02) this.frame = this.win.requestAnimationFrame(tick);
		};
		if (Math.hypot(this.velocity.x, this.velocity.y) > 0.02) this.frame = this.win.requestAnimationFrame(tick);
	}

	private stopMomentum(): void {
		if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
		this.frame = null;
	}

	reset(): void {
		this.stopMomentum();
		const pointers = [...this.pointers.values()];
		const wasNavigating = this.navigating;
		this.pointers.clear();
		this.navigating = false;
		this.zooming = false;
		for (const pointer of pointers) {
			this.options.cancelTool(pointer);
			this.release(pointer.pointerId);
		}
		if (wasNavigating) this.options.finish();
	}

	destroy(): void {
		this.reset();
		this.scroll.removeEventListener("pointerdown", this.onDown, { capture: true });
		this.scroll.removeEventListener("touchstart", this.onNativeTouch);
		this.scroll.removeEventListener("touchmove", this.onNativeTouch);
		this.scroll.removeEventListener("wheel", this.onWheel);
		this.scroll.removeEventListener("lostpointercapture", this.onLostCapture);
		this.doc.removeEventListener("pointermove", this.onMove, { capture: true });
		this.doc.removeEventListener("pointerup", this.onUp, { capture: true });
		this.doc.removeEventListener("pointercancel", this.onCancel, { capture: true });
		this.win.removeEventListener("blur", this.onBlur);
		this.doc.removeEventListener("visibilitychange", this.onVisibilityChange);
	}
}

function midpoint(points: TouchPoint[]): TouchPoint {
	const a = points[0], b = points[1] ?? a;
	return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
}

function distance(points: TouchPoint[]): number {
	return points.length < 2 ? 0 : Math.hypot(points[1].clientX - points[0].clientX, points[1].clientY - points[0].clientY);
}

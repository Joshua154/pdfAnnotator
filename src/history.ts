import {
	Annotation,
	AnnotationDocument,
	BlankPage,
	addAnnotation,
	cloneAnnotation,
	getOrCreatePage,
	removeAnnotation,
} from "./annotations/model";

/** A reversible mutation of the annotation model. */
export interface Command {
	apply(doc: AnnotationDocument): void;
	revert(doc: AnnotationDocument): void;
	/** Page affected, so the view knows what to re-render. */
	page: number;
	/** All affected pages for an atomic edit spanning several pages. */
	pages?: number[];
	layoutChanged?: boolean;
}

export interface AnnotationLocation {
	page: number;
	index: number;
	ann: Annotation;
}

/** Replace a set of annotations atomically, retaining their stacking order on undo. */
export class ChangeAnnotationsCommand implements Command {
	readonly page: number;
	readonly pages: number[];
	private before: AnnotationLocation[];
	private after: AnnotationLocation[];

	constructor(before: AnnotationLocation[], after: AnnotationLocation[]) {
		const copy = (items: AnnotationLocation[]) => items.map(item => ({ ...item, ann: cloneAnnotation(item.ann) }));
		this.before = copy(before);
		this.after = copy(after);
		this.pages = [...new Set([...before, ...after].map(item => item.page))];
		this.page = this.pages[0];
	}

	apply(doc: AnnotationDocument): void { this.replace(doc, this.before, this.after); }
	revert(doc: AnnotationDocument): void { this.replace(doc, this.after, this.before); }

	private replace(doc: AnnotationDocument, remove: AnnotationLocation[], insert: AnnotationLocation[]): void {
		for (const item of remove) removeAnnotation(doc, item.page, item.ann.id);
		for (const item of [...insert].sort((a, b) => a.index - b.index)) {
			getOrCreatePage(doc, item.page).items.splice(item.index, 0, cloneAnnotation(item.ann));
		}
	}
}

export class InsertBlankPageCommand implements Command {
	readonly layoutChanged = true;
	readonly page: number;
	private index: number;
	constructor(doc: AnnotationDocument, private blank: BlankPage, after: number) {
		this.page = blank.page;
		const previous = doc.blankPages.findIndex((p) => p.page === after);
		const first = doc.blankPages.findIndex((p) => p.afterPage === after);
		this.index = previous >= 0 ? previous + 1 : first >= 0 ? first : doc.blankPages.length;
	}
	apply(doc: AnnotationDocument): void {
		doc.blankPages.splice(this.index, 0, { ...this.blank });
	}
	revert(doc: AnnotationDocument): void {
		doc.blankPages = doc.blankPages.filter((p) => p.page !== this.page);
		doc.pages.delete(this.page);
	}
}

export class AddCommand implements Command {
	constructor(public page: number, private ann: Annotation) {}
	apply(doc: AnnotationDocument): void {
		addAnnotation(doc, this.page, cloneAnnotation(this.ann));
	}
	revert(doc: AnnotationDocument): void {
		removeAnnotation(doc, this.page, this.ann.id);
	}
}

export class RemoveCommand implements Command {
	constructor(public page: number, private ann: Annotation) {}
	apply(doc: AnnotationDocument): void {
		removeAnnotation(doc, this.page, this.ann.id);
	}
	revert(doc: AnnotationDocument): void {
		addAnnotation(doc, this.page, cloneAnnotation(this.ann));
	}
}

/** Replaces an annotation's full state (used for move/resize/edit). */
export class UpdateCommand implements Command {
	private before: Annotation;
	private after: Annotation;
	constructor(public page: number, before: Annotation, after: Annotation) {
		this.before = cloneAnnotation(before);
		this.after = cloneAnnotation(after);
	}
	apply(doc: AnnotationDocument): void {
		removeAnnotation(doc, this.page, this.after.id);
		addAnnotation(doc, this.page, cloneAnnotation(this.after));
	}
	revert(doc: AnnotationDocument): void {
		removeAnnotation(doc, this.page, this.before.id);
		addAnnotation(doc, this.page, cloneAnnotation(this.before));
	}
}

export class History {
	private undoStack: Command[] = [];
	private redoStack: Command[] = [];
	private limit = 200;

	/** Callback fired after any apply/revert so the view can refresh. */
	onChange: ((page: number, layoutChanged?: boolean, pages?: number[]) => void) | null = null;

	/** Execute a command and push it onto the undo stack. */
	execute(doc: AnnotationDocument, cmd: Command): void {
		cmd.apply(doc);
		this.undoStack.push(cmd);
		if (this.undoStack.length > this.limit) this.undoStack.shift();
		this.redoStack.length = 0;
		this.onChange?.(cmd.page, cmd.layoutChanged, cmd.pages);
	}

	/** Push a command that has ALREADY been applied to the model. */
	push(cmd: Command): void {
		this.undoStack.push(cmd);
		if (this.undoStack.length > this.limit) this.undoStack.shift();
		this.redoStack.length = 0;
		this.onChange?.(cmd.page, cmd.layoutChanged, cmd.pages);
	}

	undo(doc: AnnotationDocument): boolean {
		const cmd = this.undoStack.pop();
		if (!cmd) return false;
		cmd.revert(doc);
		this.redoStack.push(cmd);
		this.onChange?.(cmd.page, cmd.layoutChanged, cmd.pages);
		return true;
	}

	redo(doc: AnnotationDocument): boolean {
		const cmd = this.redoStack.pop();
		if (!cmd) return false;
		cmd.apply(doc);
		this.undoStack.push(cmd);
		this.onChange?.(cmd.page, cmd.layoutChanged, cmd.pages);
		return true;
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}
	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear(): void {
		this.undoStack.length = 0;
		this.redoStack.length = 0;
	}
}

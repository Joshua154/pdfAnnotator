import {
	Annotation,
	AnnotationDocument,
	BlankPage,
	addAnnotation,
	cloneAnnotation,
	removeAnnotation,
} from "./annotations/model";

/** A reversible mutation of the annotation model. */
export interface Command {
	apply(doc: AnnotationDocument): void;
	revert(doc: AnnotationDocument): void;
	/** Page affected, so the view knows what to re-render. */
	page: number;
	layoutChanged?: boolean;
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
	onChange: ((page: number, layoutChanged?: boolean) => void) | null = null;

	/** Execute a command and push it onto the undo stack. */
	execute(doc: AnnotationDocument, cmd: Command): void {
		cmd.apply(doc);
		this.undoStack.push(cmd);
		if (this.undoStack.length > this.limit) this.undoStack.shift();
		this.redoStack.length = 0;
		this.onChange?.(cmd.page, cmd.layoutChanged);
	}

	/** Push a command that has ALREADY been applied to the model. */
	push(cmd: Command): void {
		this.undoStack.push(cmd);
		if (this.undoStack.length > this.limit) this.undoStack.shift();
		this.redoStack.length = 0;
		this.onChange?.(cmd.page, cmd.layoutChanged);
	}

	undo(doc: AnnotationDocument): boolean {
		const cmd = this.undoStack.pop();
		if (!cmd) return false;
		cmd.revert(doc);
		this.redoStack.push(cmd);
		this.onChange?.(cmd.page, cmd.layoutChanged);
		return true;
	}

	redo(doc: AnnotationDocument): boolean {
		const cmd = this.redoStack.pop();
		if (!cmd) return false;
		cmd.apply(doc);
		this.undoStack.push(cmd);
		this.onChange?.(cmd.page, cmd.layoutChanged);
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

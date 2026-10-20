# Changelog

## Unreleased

- Enable native PDF text selection and copying with the Select tool while retaining annotation move and resize controls.
- Add search for selectable PDF text and written text annotations, including blank pages, with Ctrl/Cmd+F, scope filters, match navigation, and temporary highlights.
- Add `{sourceDir}` and `{sourcePath}` storage placeholders and ordered annotation folder rules that route PDFs by source directory, with the existing folder setting as a fallback.

## 0.3.0

- Add annotated PDF export from the toolbar and command palette, preserving source PDF content and including inserted blank pages. Export creates a separate file beside the source with collision-free filenames, progress reporting, and cancellation on view close.
- Fix touch scrolling in Select and add two-finger panning and PDF pinch zoom, keeping the zoom centered under the gesture and refreshing nearby pages after release.
- Cancel unfinished drawing, erasing, and annotation dragging when a second finger starts navigation; prevent canceled gestures from saving accidental annotations.

## 0.2.0

- Add blank pages after any PDF or blank page for extra annotation space, with undo/redo. Blank pages are saved in the annotation note and restored when reopening the PDF.
- Add an Insert menu for editable LaTeX math and TikZ diagrams, with source previews, resizing, persistence, and undo/redo. LaTeX uses Obsidian's built-in MathJax; TikZ requires an enabled community renderer such as TikZJax.
- Support inserting linked Excalidraw drawings from the vault, with resizing, undo/redo, and automatic refresh when the drawing is saved. Displaying drawings requires the Excalidraw plugin; click a selected drawing again to open it for editing.
- Add selection across multiple pages using Shift-click, plus Ctrl/Cmd+A to select all annotations with the Select tool.
- Add cut, copy, paste, and drag-and-drop across PDF and blank pages, preserving relative page spacing and attachment links. Dragging supports automatic scrolling near the viewer edges and cancellation with Escape.
- Make each cut, paste, drag, or deletion of a selection a single undo/redo step, including operations spanning multiple pages.

## 0.1.0

- Add PDF drawing, freehand and text highlights, shapes, text boxes, images, selection, and undo/redo.
- Store annotations as Markdown notes without modifying the original PDF.
- Add page snapping, smooth scrolling with held arrow keys, zoom, and fit controls.
- Add configurable default tools, annotation folders, and pasted-image locations and filenames.
- Support vault-relative and PDF-relative storage with filename, folder, date, and time placeholders.
- Add release metadata validation, automated tests, installable asset packaging, and GitHub workflows.

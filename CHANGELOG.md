# Changelog

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

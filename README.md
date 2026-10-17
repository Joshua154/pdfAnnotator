# PDF Annotator

Draw, highlight, and add text, shapes, and images to PDFs in Obsidian. Annotations are saved in readable Markdown notes; the original PDF is never modified.

## Features

- Pen, freehand highlighter, eraser, and text selection highlighting.
- Text boxes, rectangles, ellipses, lines, and arrows.
- Insert editable LaTeX math, TikZ diagrams, and linked Excalidraw drawings.
- Select, move, resize, and delete annotations, with undo and redo.
- Cut, copy, paste, and drag selections across PDF and blank pages.
- Paste images from the clipboard and configure their storage folders and filenames.
- Zoom, fit to width or height, page snapping, and smooth keyboard scrolling.
- Insert blank pages for extra annotation space, with undo and redo.
- Autosave to one Markdown note per PDF, with page links and annotation data.
- Store notes and images in vault folders or relative to each PDF, using path templates.
- Export a separate PDF with visible annotations and inserted blank pages.

## Installation

Requires Obsidian **1.7.2 or newer**.

Until the plugin is published in the community directory, install it manually:

1. Download `main.js`, `manifest.json`, and `styles.css` from a published GitHub release of this repository. The source archive alone is not an installable plugin.
2. Create `<vault>/.obsidian/plugins/pdf-annotator/` (replace `.obsidian` if your vault uses a custom configuration folder).
3. Copy the three files into that folder.
4. Reload Obsidian and enable **PDF Annotator** in **Settings → Community plugins**.

After community directory approval, search for **PDF Annotator** in Obsidian's community plugin browser and install it there.

## Usage

Right-click a PDF in the file explorer and choose **Annotate PDF**, or open a PDF and run **PDF Annotator: Annotate current PDF** from the command palette. The standard PDF viewer remains available.

Select a tool in the toolbar, then draw or click on a page. For text highlighting, choose **Highlight PDF text** and select text in the PDF. Text highlighting requires a PDF with selectable text; scanned documents need OCR from another tool first.

Use **Select** to move or resize an annotation, or select it and press Delete. Click a text annotation twice with Select to edit it. Click outside a text box or press Ctrl/Cmd+Enter to save its text; Escape cancels editing.

On touch screens, swipe empty page space with **Select** to scroll. Use two fingers to pan or pinch to zoom while using any annotation tool. Adding a second finger cancels an unfinished stroke, erase, or annotation drag so navigation does not change annotations. Lift both fingers before starting a new annotation.

Shift-click annotations to add or remove them from a selection, including on other pages. Ctrl/Cmd+A with Select active selects all annotations in the document. Use Ctrl/Cmd+C to copy or Ctrl/Cmd+X to cut, then click empty space on a destination page and press Ctrl/Cmd+V. Without a destination click, paste uses the page currently in view. Pasted annotations receive new IDs; images and drawings keep their existing attachment links.

Drag any selected annotation to move the whole selection to another page. Hold near the top or bottom of the viewer to scroll while dragging, or use the mouse wheel. Selections spanning multiple pages retain their relative page spacing, including blank pages. The destination must have enough pages for the entire selection; insert blank pages first if needed. Each cut, paste, drag, or deletion is one undo step. Escape cancels an in-progress drag, and dropping outside the pages leaves the selection in place. Moving or copying a PDF text highlight detaches its original text-selection link while retaining its quoted text and highlight rectangles.

Paste a clipboard image with Ctrl/Cmd+V while the annotator is focused. The image is saved as a vault file and can then be moved or resized. Use **Open annotation note** in the toolbar to see the generated Markdown.

### LaTeX, TikZ, and Excalidraw

Use the **+** toolbar button (**Insert LaTeX, TikZ, or Excalidraw**) to insert content on the current PDF or blank page:

- **Insert LaTeX** opens a source editor for math expressions, rendered with Obsidian's built-in MathJax. Enter an expression such as `\frac{a}{b}`; surrounding `$`, `$$`, `\(`, or `\[` delimiters are optional. This supports MathJax math, not full LaTeX documents.
- **Insert TikZ** opens a source editor with an example diagram. Enable a community plugin that renders `tikz` code blocks, such as [TikZJax](https://github.com/artisticat1/obsidian-tikzjax). Enter a `tikzpicture` environment or a complete document; a `document` wrapper is added when absent. Available packages and rendering behavior depend on that plugin.
- **Insert Excalidraw drawing** searches existing vault drawings, including `.excalidraw`, `.excalidraw.md`, and Markdown files with `excalidraw-plugin` frontmatter. Create drawings with the [Excalidraw plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin) first and keep it enabled to display them.

For LaTeX and TikZ, click **Preview** after editing, then **Insert** or **Save** (Ctrl/Cmd+Enter). **Cancel** or Escape discards changes. Source is retained even when a renderer is unavailable, with a message in place of the preview.

Use **Select** to move, resize, or delete inserted content. Click it twice to edit LaTeX/TikZ source or open the linked Excalidraw drawing in another pane. Saving a linked drawing refreshes its PDF annotation. Insertions, source edits, moves, resizes, and deletions support undo/redo; edits made inside Excalidraw use Excalidraw's own history. Removing an annotation keeps the source drawing in the vault. Renaming or moving a linked drawing requires reinserting it.

Sources, drawing paths, and positions are saved in the annotation note and restored when the PDF reopens. TikZ and Excalidraw rendering is delegated to their plugins, whose own settings and network behavior apply.

### Blank pages

Use **Insert blank page after current page** (the file-plus toolbar button) to add annotation space after the page you are viewing. The new page matches its size and supports drawing, text, shapes, and pasted images. You can insert several blank pages, including after another blank page, and undo or redo insertion. Blank pages, including empty ones, are saved in the annotation note and restored when you reopen the PDF in the annotator. They do not change the original PDF or its page links and do not appear in other PDF readers.

### Annotated PDF export

Click **Export annotated PDF** (the file-down toolbar button), or run **PDF Annotator: Export annotated PDF** while an annotator pane is active. The plugin saves a separate file beside the source: `Lecture.pdf` becomes `Lecture.annotated.pdf`. Repeated exports receive numeric suffixes, preserving previous exports.

The exported copy includes all PDF pages and inserted blank pages in viewer order, including empty blank pages. It preserves the original PDF's searchable text and graphics. Plugin annotations are flattened into the copy so they display in other PDF readers: drawings and highlights remain vector graphics; text boxes, images, LaTeX, TikZ, and Excalidraw previews are embedded as images at up to 144 dpi. Continue editing annotations in the original annotator and export again when needed.

Active text edits are committed before export. Changes made while export is running are included in the next export. LaTeX and diagram renderers must be available; missing images, failed previews, and unsupported or encrypted PDFs produce an error instead of an incomplete export. Closing the annotator or switching its PDF cancels pending export work. The source PDF and annotation note remain available for editing.

### Keyboard controls

Click the PDF first to focus the viewer. Shortcuts are ignored while typing in a text editor or settings field.

| Key | Action |
| --- | --- |
| Left / Right | Snap to the previous / next page, once per press |
| Up / Down | Scroll smoothly; hold to keep scrolling |
| V | Select, move, resize |
| P | Pen |
| H | Freehand highlighter |
| E | Eraser |
| T | Text box |
| S | Highlight selected PDF text |
| R / O / L / A | Rectangle / ellipse / line / arrow |
| Shift-click | Add/remove an annotation from the selection, across pages |
| Ctrl/Cmd+A | Select all annotations (Select tool) |
| Ctrl/Cmd+X / C / V | Cut / copy / paste annotations across pages |
| Delete / Backspace | Delete selected annotations |
| Escape | Cancel dragging, clear selection, or cancel text editing |
| Ctrl/Cmd+Z | Undo |
| Ctrl/Cmd+Shift+Z | Redo |
| Ctrl/Cmd+Y | Redo |

### Annotation folders

The default location is `PDF Annotations/<PDF name>.annotations.md`, relative to the vault root. Enable **Annotations relative to PDF** to resolve the folder from each PDF's containing directory.

For `Courses/Math/Lecture.pdf`, with relative storage enabled:

| Annotations folder | Resulting note |
| --- | --- |
| Empty or `.` | `Courses/Math/Lecture.annotations.md` |
| `Notes` | `Courses/Math/Notes/Lecture.annotations.md` |
| `../Notes` | `Courses/Notes/Lecture.annotations.md` |
| `Notes/{filename}` | `Courses/Math/Notes/Lecture/Lecture.annotations.md` |

Nested folders are created automatically. Paths must remain inside the vault. Changing a storage setting does not move existing notes; the new location is used when a PDF is opened again. PDF files with the same basename can share a note in a common annotation folder, so use PDF-relative folders to keep those notes separate.

### Pasted image storage

**Pasted image location** offers three choices:

- **Obsidian attachment folder**: follow Obsidian's attachment settings, using the annotation note as the source when available. This is the default.
- **Relative to vault root**: use **Pasted images folder** from the vault root.
- **Relative to PDF folder**: use **Pasted images folder** from the PDF's directory.

An empty custom folder saves directly in the selected location. Set **Pasted image filename** without an extension; the correct image extension is added automatically. Duplicate names receive numeric suffixes. Existing images remain at their original paths.

For example, choose a PDF-relative location, folder `Images/{filename}`, and filename `{filename}-{timestamp}` to keep each PDF's images together.

### Template placeholders

These placeholders work in annotation folders, pasted-image folders, and pasted-image filenames:

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `{filename}` | PDF filename without its extension | `Lecture` |
| `{folder}` | Name of the PDF's immediate parent folder; empty at the vault root | `Math` |
| `{date}` | Local date | `2026-10-16` |
| `{time}` | Local time with filename-safe separators | `14-05-09` |
| `{timestamp}` | Local date and time | `20261016140509` |
| `{year}` | Four-digit year | `2026` |
| `{month}` | Two-digit month | `10` |
| `{day}` | Two-digit day | `16` |

Annotation templates are evaluated when opening a PDF, and image templates when pasting. A date placeholder in an annotation folder therefore selects a different location on another day. Filenames cannot contain directory separators; configure those in the folder setting.

## Storage and privacy

The plugin reads PDFs and writes annotation notes, image attachments, exported PDFs, and plugin settings inside your vault. It makes no network requests, collects no telemetry, requires no account or payment, and does not access files outside the vault. Obsidian's own sync services may sync these files if enabled.

Annotation notes contain readable text summaries, links to PDF pages, and `pdf-annotations` fenced JSON blocks that store the drawings and positions. Keep those blocks intact to preserve annotations. Other PDF readers display these overlays only in an exported annotated copy. Removing an image annotation does not delete its image attachment.

Moving or renaming PDFs or annotation notes does not automatically migrate their stored association. Keep backups and reopen the original storage location if a changed path appears to have no annotations. Simultaneous editing of the same PDF in multiple panes is not coordinated.

The runtime uses Obsidian and browser APIs rather than Node.js or Electron APIs. Desktop pop-out windows and mobile behavior still require manual verification before publishing; clipboard and keyboard behavior depend on the device.

## Development

Use Node.js 22 or newer and npm:

```sh
npm ci
npm run dev
```

Develop in a test vault with this checkout at `.obsidian/plugins/pdf-annotator/`. The development build writes `main.js` and watches for changes. Reload the plugin after rebuilding.

```sh
npm test                 # Automated behavior tests
npm run build           # Type-check and build the production bundle
npm run check           # Validate release metadata, test, and build
npm run release:prepare # Run all checks and copy installable files to dist/
```

The `dist/` directory contains `main.js`, `manifest.json`, and `styles.css` for installation or release upload. Generated bundles, local settings (`data.json`), and dependencies are not committed.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and [RELEASING.md](RELEASING.md) for versioning, GitHub releases, and community submission. Report problems through this repository's Issues tab, including Obsidian version, device, steps to reproduce, and relevant console errors. Do not include private PDFs or notes.

## License

[MIT](LICENSE), copyright Joshua. PDF rendering uses the [PDF.js](https://github.com/mozilla/pdf.js) library bundled with Obsidian. The `pdfjs-dist` development dependency provides types and is not bundled into this plugin. Export uses the bundled [pdf-lib](https://pdf-lib.js.org/) library.

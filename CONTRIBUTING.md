# Contributing

## Setup

Use Node.js 22 or newer (`nvm use` reads `.nvmrc`), run `npm ci`, and develop in a test vault. Run `npm run dev` to rebuild on changes. Match the checkout's folder name to the manifest ID: `.obsidian/plugins/pdf-annotator/`.

Before opening a pull request, run:

```sh
npm run check
```

Add focused behavior tests for changes to navigation, storage paths, serialization, or lifecycle cleanup. Automated tests run outside Obsidian with small DOM/vault fixtures; they do not replace testing the plugin inside Obsidian.

## Manual checks

Use disposable PDFs and notes in a test vault:

- Open a PDF through the file menu and command palette, including an existing inactive tab.
- Draw, highlight selectable text, add shapes and text, paste an image, move/resize/delete an annotation, and undo/redo.
- Shift-select annotations across PDF and blank pages, cut/copy/paste, and drag them across several pages at different zoom levels. Test edge scrolling, mouse-wheel scrolling, Escape, dropping in gaps or outside the viewer, and insufficient destination pages. Undo/redo must restore every affected page and its stacking order. Verify normal text clipboard behavior inside editors and image pasting still work.
- Close and reopen the PDF; verify annotations and pasted images restore correctly.
- Insert LaTeX, TikZ (with and without a TikZ renderer), and Excalidraw drawings (with and without Excalidraw enabled). Preview/edit source, cancel, move/resize, undo/redo, and reopen on PDF and blank pages. Save a linked drawing in another pane and check its preview refreshes. Close a view while rendering is pending and check for orphaned components or errors.
- Open the Markdown note and follow a page link. Confirm the original PDF is unchanged.
- Export through the toolbar and command palette with every annotation type, Unicode text, images, and empty/annotated blank pages. Open the exported copy in another PDF reader and verify stacking, transparency, page order, crop/rotation alignment, and searchable source text. Repeat export to verify existing files are preserved. Test missing images/renderers, encrypted PDFs, closing/switching files during export, and exporting from mobile and pop-out windows.
- Try Left/Right snapping and held Up/Down scrolling at the first and last pages and different zoom levels.
- Test text editing and toolbar inputs; navigation must not steal editing keys.
- Test vault-relative and PDF-relative paths, empty folders, nested folders, templates, and repeated image filenames.
- Switch files in the same pane and paste once; exactly one image should appear.
- Close a text editor or text-highlighting view, disable/re-enable the plugin, and verify there are no orphaned listeners, duplicate pastes, or unsaved edits.
- Check light/dark themes, different pane sizes, and PDFs with mixed page sizes.
- On mobile, swipe empty space with Select in both axes and check momentum scrolling. Pinch and pan with two fingers in each tool, including across PDF/blank page boundaries and at zoom limits. Add a second finger during drawing, erasing, and dragging; annotations and undo history must stay unchanged. Lift either finger first, cancel a gesture, background/close the view, and verify a fresh annotation still works. Check text selection and keyboard editing retain their normal behavior.
- Verify the minimum supported Obsidian release as well as the current stable release.
- Test mobile and desktop pop-out windows before claiming support; record versions and any limitations in the release notes.

## Runtime conventions

Use public Obsidian APIs and browser APIs so the runtime can work on mobile. Keep Node.js tooling in scripts and build files. Bind global listeners to their owning view/component, and clean up listeners, timers, animation frames, and PDF resources when the view closes. Do not add telemetry or network use without documenting it and reviewing Obsidian's developer policies.

Preserve the annotation file format or provide a migration for existing notes when changing it. Keep README settings and shortcut documentation in sync with behavior.

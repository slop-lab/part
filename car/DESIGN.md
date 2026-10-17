# CAR Workbench Design System

This file extracts the existing `@slop-lab/part-browser` DOM system for the CAR surface. It is a reuse contract, not a visual redesign.

## 1. Atmosphere & Identity

CAR is a compact, dependable engineering console: conversation on the left, inspectable execution evidence on the right. The signature is **evidence beside action**—a user can ask for work and immediately inspect runs, context metadata, requests, events, files, diffs, and artifacts without leaving the surface. Primary users are keyboard-oriented software engineers; the stress persona is a user working at 200% zoom or with reduced motion who must still connect, send, refresh, inspect errors, and read long output.

## 2. Color

The palette is inherited from `packages/browser/src/styles.css`; CAR adds semantic aliases only.

| Role            | Token                  |     Value | Usage                                    |
| --------------- | ---------------------- | --------: | ---------------------------------------- |
| Surface/primary | `--part-background`    | `#101825` | Page and shared component background     |
| Surface/raised  | `--car-surface-raised` | `#172235` | Header, inspector controls, selected tab |
| Surface/inset   | `--car-surface-inset`  | `#0b121d` | Code, file, diff, and log viewers        |
| Text/primary    | `--part-foreground`    | `#e7edf6` | Body and headings                        |
| Text/secondary  | `--car-text-muted`     | `#aec0d6` | Metadata, help, inactive tabs            |
| Border/default  | `--part-border`        | `#314359` | Shared component outlines and separators |
| Accent/action   | `--car-action`         | `#244466` | Buttons and selected controls            |
| Accent/focus    | `--car-focus`          | `#9accff` | Focus indicators only                    |
| Status/success  | `--car-success`        | `#7dd3a7` | Connected state                          |
| Status/warning  | `--car-warning`        | `#f2c879` | Truncation and metadata-only notices     |
| Status/error    | `--car-error`          | `#ff9b9b` | Permission, query, and connection errors |
| Diff/add        | `--car-diff-add`       | `#193c2c` | Added lines                              |
| Diff/remove     | `--car-diff-remove`    | `#4a2329` | Removed lines                            |

Rules: accent colors communicate state or interaction, never decoration. Permission errors remain visible until a later successful action replaces them. Full-trace data is never implied when configuration reports metadata tracing.

## 3. Typography

| Level      |       Size | Weight | Line height | Usage                             |
| ---------- | ---------: | -----: | ----------: | --------------------------------- |
| H1         |  `1.25rem` |    700 |         1.3 | Product title                     |
| H2         |     `1rem` |    650 |         1.4 | Panel headings                    |
| Body       |     `1rem` |    400 |         1.6 | Conversation and readable content |
| Body/small | `0.875rem` |    400 |         1.5 | Labels and supporting copy        |
| Caption    |  `0.75rem` |    600 |         1.4 | Status, tab metadata, badges      |

- Primary: `system-ui, sans-serif`, inherited through `--part-font`.
- Code: `ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace`.
- No external fonts. Prose uses language-aware line breaking: Korean words stay intact with `word-break: keep-all`. Code, paths, digests, logs, and diffs use the code stack and `overflow-wrap: anywhere` for unbroken technical strings.

## 4. Spacing & Layout

The base unit is 4px.

| Token                              |     Value | Usage                   |
| ---------------------------------- | --------: | ----------------------- |
| `--car-space-1`                    | `0.25rem` | Tight inline separation |
| `--car-space-2`                    |  `0.5rem` | Compact controls        |
| `--car-space-3`                    | `0.75rem` | Control groups          |
| `--part-spacing` / `--car-space-4` |    `1rem` | Panel and card rhythm   |
| `--car-space-6`                    |  `1.5rem` | Major region separation |

- The page is a `scroll-body-shell` bounded by `100dvb`: header remains visible and the workbench body owns vertical space.
- The workbench is a `list-detail`-style split: chat and inspector each own their internal scroll. Every shrinking grid/flex child uses `min-block-size: 0` and `min-inline-size: 0`.
- At narrow widths and 200% zoom, the shell becomes one readable document column; no primary horizontal scrolling. Code viewers may scroll internally but default to wrapping.
- Minimum interactive target block size is 44px. Long paths, tokens, URLs, and unbroken output use `overflow-wrap: anywhere`.

## 5. Components

### Connection form

- **Structure**: labeled password input, Connect button, live connection status; token remains in memory only.
- **States**: disconnected, connecting, connected, error, disabled while connecting.
- **Accessibility**: real label, password semantics, submit by keyboard, polite status; token is never reflected into DOM text or persistent storage.
- **Layout**: wrapping `cluster`; fixed header region.

### Shared Chat

- **Structure**: public `createChat` output with CAR command adapter.
- **Variants**: streamed and settled messages; default action rendering includes source-targeted null-input cancellation.
- **States**: inherited empty, pending, delivery unknown, rejected, failed, disconnected.
- **Accessibility**: inherited conversation log, labeled composer, IME-safe Enter behavior, focus-visible controls.
- **Layout**: chat thread is its scroll owner; composer remains below it.

### Inspector tabs

- **Structure**: tablist, Refresh action, status region, selected tab panel.
- **Tabs**: Runs, Workflows, History, Context, Requests, Events, Workspace, Diff, Artifact, Items.
- **States**: idle, loading, populated, empty, permission error, unavailable, truncated.
- **Status scope**: status belongs to the selected tab. Every tab selection invalidates prior requests and clears prior status before mounting forms, Items, or Workflows. Late responses must never replace the current panel.
- **Status color**: explicit `data-state` values map loading to secondary text, success to success, warning to warning, and error to error; panel content must never infer status color.
- **Accessibility**: roving tab focus with ArrowLeft/ArrowRight/Home/End, `aria-selected`, `aria-controls`, labeled refresh status.
- **Layout**: toolbar is fixed within the panel; selected panel owns inspector scrolling.

### Safe evidence viewer

- **Structure**: heading/metadata plus `pre` or structured definition/list content created with DOM APIs.
- **Variants**: generic JSON, plain text/log, file, unified diff, artifact bytes, metadata notice.
- **States**: empty, loading, content, error, truncated, binary artifact summary.
- **Accessibility**: visible labels and plain-language errors; color never carries diff meaning alone.
- **Safety**: all remote values enter through `textContent`; no `innerHTML`, executable links, HTML/SVG interpretation, iframe, object URL, or script execution. Base64 artifacts are decoded with a bounded byte limit and interpreted as UTF-8 text only when valid; otherwise show a binary summary.

### Query input

- **Structure**: labeled text input and Load button for run ID, workspace path, diff path, or artifact `store`/`id`.
- **States**: ready, loading, invalid, error, successful.
- **Accessibility**: labels communicate the expected identifier; errors remain adjacent and announced.
- **Layout**: wrapping `cluster`; no hidden tool invocation or undeclared route.

### Workflow launcher

- **Structure**: definition selector, stacked JSON-input label and textarea, then a separate wrapping action group with Start and optional cancellation request.
- **States**: loading definitions, settled definitions, empty, start pending, accepted, rejected, unknown delivery, cancellation pending.
- **Accessibility**: visible labels, live status, disabled actions while their request is pending; populated controls are never described as loading.
- **Layout**: single-column grid at every width. Labels own full-width controls; actions sit below the textarea rather than sharing its row.

## 6. Motion & Interaction

| Type  | Duration | Easing     | Usage                         |
| ----- | -------: | ---------- | ----------------------------- |
| Micro |  `120ms` | `ease-out` | Button and tab state feedback |

Only color, opacity, and transform may transition. There is no decorative motion. `prefers-reduced-motion: reduce` removes transitions and preserves immediate state feedback. Refresh must issue real version-1 queries; tab selection alone never fabricates data.

## 7. Depth & Surface

Strategy: **borders plus restrained tonal shift**, matching the existing browser stylesheet. Shared `.part-ui` cards retain their border and radius. CAR regions use primary, raised, and inset tones; no shadows, blur, gradients, or glass effects are introduced.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Target WCAG 2.2 AA: 4.5:1 body contrast, 3:1 large text and component boundaries, persistent visible focus, full keyboard operation, and reduced-motion support.
- Connection, refresh, send, cancel, tabs, and query forms must work without a pointer.
- Status and errors are announced without moving focus unexpectedly.
- Metadata tracing must present a readable summary and explicit metadata-only notice; private/full raw fields are shown only when the API actually returns them.
- Safe rendering is mandatory for every API value, including JSON keys and error messages.

### Accepted Debt

| Item                                             | Location      | Why accepted                                                                                                               | Owner / Exit                                            |
| ------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Cross-browser and production-scale certification | CAR Workbench | Local Chromium interaction and 31-capture responsive QA passed; this is not certification of every browser or history size | Extend the browser suite before claiming those profiles |

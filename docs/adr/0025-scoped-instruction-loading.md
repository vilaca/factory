# 0025 — Scoped instruction files are loaded on demand

## Context

* Instruction files can be named `AGENTS.md`, `CLAUDE.md`, `.cursorrules` or `INSTRUCTIONS.md`.
* They can exist under `~/.factory/`, project root, and its child folders.
* Instruction files are not mandatory: they might not exist in any given folder.

## Decision

### Discovery rules

- The project root boundary is the process working directory at session initialisation. Parent traversal must never ascend above this directory.
- A directory becomes *touched* when it or a file within it is explicitly referenced by an operation.
- When a directory becomes touched, discover scoped instruction files in that directory and each ancestor up to project root.
- Discoveries happen on tool start regardless of whether the tool succeeds (failed calls still mark touched dirs and load instructions).
- Each instruction file is loaded at most once per active conversation context. If the session is reset (`/clear`) or a compaction rebuild drops instruction content, the loader may re-read as part of rebuilding the prompt.
- Instruction files under `~/.factory/` are treated as virtual project-root instructions.

### Ordering — deepest directory first

Sources are assembled in **child → root** order (deepest directory first), so the most specific instructions for the directory being worked in appear earliest in the prompt. Virtual `~/.factory/` entries follow all project directories.

Rationale: the agent is most likely to need the instruction file closest to the file it is reading or editing. Placing that file first ensures it is always present regardless of total instruction volume. Shallower, more general files provide supporting context that comes after.

### No byte cap on scoped instructions

There is **no size cap** on the combined scoped instruction content. All discovered files are included in full. The context manager handles overall window budgeting.

The startup `loadProjectInstructions` path (root-only, loaded once at session start) is separate and also has no cap.

Rationale: a cap applied in source order would silently drop the deepest — and most relevant — file when shallower files are large, defeating the feature. The context manager is the correct place to manage window pressure.

## Invariants future contributors must preserve

- Scoped instruction files are loaded only from touched directories and their ancestors up to project root.
- Parent traversal must never escape the startup project-root boundary.
- Each instruction file is loaded at most once per active conversation context.
- **Ordering is child → root (deepest first)**; virtual `~/.factory/` entries come last.
- No byte cap is applied to scoped instruction loading. Do not reintroduce one.
- The `## From <path>` header is emitted for each loaded file.

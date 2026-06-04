# 0025 — Scoped instruction files are loaded on demand

## Context

* Instruction files can be named `AGENTS.md`, `CLAUDE.md`, `.cursorrules` or `INSTRUCTIONS.md`.
* They can exist on ~/.factory/, project root and it's child folders.
* Instruction files are not mandatory: they might not exist in folders, project root or ~/.factory folder.

## Decision

Scoped discovery rules:

- The project root boundary is the process working directory at session initialization. Parent traversal must never ascend above this directory.
- A directory becomes touched when it or a file within it is explicitly referenced by an operation.
- When a directory becomes touched, discover scoped instruction files in that directory and each ancestor up to project root.
- Discoveries happen on tool start regardless of whether the tool succeeds (failed calls still mark touched dirs and load instructions).
- Each instruction file is loaded at most once per session.
- Merge instruction sources in root → child order so more local rules appear later in the prompt.
- Preserve existing size-cap, truncation, and `## From <path>` header behavior.
- Instruction files under `~/.factory/` are treated as virtual project-root instructions.
- Keep a record of loaded instruction files. If an instruction file is already present in the session context, it must not be read again.

## Invariants future contributors must preserve

- Scoped instruction files are loaded only from touched directories and their ancestors up to project root.
- Parent traversal must never escape the startup project-root boundary.
- Each instruction file is loaded at most once per session.
- Ordering remains root → child.
- Instruction files should be loaded once per active conversation context. If the session is reset (/clear) or a compaction rebuild drops instruction content, the loader should be allowed to re-read as part of rebuilding the prompt. The “don’t re-read” constraint applies only while the current scoped instruction state is still in place.
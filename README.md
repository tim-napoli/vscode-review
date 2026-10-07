# VSCode Review

VSCode extension: comment on the staged diff via the Comments API. "+" gutter on the
staged diff → inline comment → written to `.review.json` (repo root, git-ignored).

## Structure

- `package.json` — extension manifest (commands, comments/* menus)
- `src/extension.ts` — logic, compiled to `out/`
- `tsconfig.json` — `types: ["vscode", "node"]` is deliberate, otherwise tsc walks up
  into `../../node_modules/@types` (three, webgpu...) and breaks on the missing DOM lib

## Bootstrap

```
npm install
npm run compile
```

## Installing locally

No F5 / Extension Development Host — VSCodium has single-instance behavior: opening
this folder in a 2nd window just refocuses the already-open window instead of creating
a new one. Instead:

1. `Ctrl+Shift+P` → **Developer: Install Extension from Location...**
2. Select this folder (the one with `package.json`)
3. Runs directly in the current window

## Edit loop

1. Edit `src/extension.ts`
2. `npm run compile`
3. `Ctrl+Shift+P` → **Developer: Reload Window**

## Non-obvious point

Identifying the two sides of a diff opened from Source Control (the "Staged Changes"
group): URI scheme `git`, JSON query with a `ref` field.
- staged side (right, new content): `ref === ""` (empty string)
- HEAD side (left, old content — needed to comment on a deletion): `ref === "HEAD"`

Trap: `ref === "~"` looks like "staged" but is something else (used elsewhere, in the
working-tree diff) — matches neither of these two sides. Verified by instrumentation
(logging opened URIs to an output channel), no reliable official doc on this.

## `.review.json` format

```json
[
  {
    "id": "uuid",
    "file": "path/relative/to/repo.js",
    "side": "staged",
    "startLine": 10,
    "endLine": 15,
    "text": "comment",
    "excerpt": "content of the commented lines",
    "response": "how Claude handled the comment"
  }
]
```

1-based, inclusive lines. `side` specifies which version of the file `startLine`/
`endLine` refer to: `"staged"` (content after the change, the general case) or
`"head"` (content before the change — commenting on a deletion, lines absent from the
staged file so they have no `"staged"`-side match).

`response` (optional): written directly into the JSON by Claude after handling a
comment, not by the extension itself. Displayed as the thread's 2nd message (author
"Claude"), read-only — no edit/delete icon on it (see `contextValue` below). The
watcher on `.review.json` refreshes the display as soon as the file changes, so it
appears without any user action.

## Re-anchoring on file changes

`startLine`/`endLine` are frozen at comment-creation time — if lines are added/removed
elsewhere in the file between creating the comment and reopening the diff, they become
wrong. Mitigated (`locateRange`): if the text at the stored lines no longer matches
`excerpt`, searches for that text elsewhere in the document and re-anchors the comment
there. Works if the commented text just moved; no fix if the text itself was changed
or deleted (falls back to the stored lines, best effort). Matches by exact text
equality — if the same excerpt appears multiple times in the file, uses the first
occurrence.

## Current limitations

- Staged + HEAD of the same diff only (not unstaged, not an arbitrary commit) —
  extensible later by widening `sideOf`
- One comment + one response per thread (no multi-turn discussion thread)
- Delete/edit via icons on the comment (no whole-thread deletion) — reserved for the
  user's own comment via `contextValue: "editable"`, absent on Claude's response (menu
  `when` key: `comment == editable`)
- `.review.json` is watched (`createFileSystemWatcher`): any external change (manual
  deletion, cleared by a future skill) refreshes open diffs

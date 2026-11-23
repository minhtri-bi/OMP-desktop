# Decision: Folder, Chat, and Click-to-Preview Workflow (`workspace-ux`)

- **Status**: Proposed (awaiting integrator sign-off before splitting implementation)
- **Contract companion**: [`docs/contracts/file-reference-and-preview.md`](../contracts/file-reference-and-preview.md)

## Core interaction summary

Match the Antigravity click-to-preview experience on Windows:
- Clicking a **filename chip** or **file link** in chat opens the real file in a tab in the **right-hand pane**.
- **Chat and its composer stay visible** at all times when opening or switching preview/browser tabs.
- **One shared tab strip** hosts both file previews (PDF, source/text, interactive HTML) and visible browser tabs.
- **Second click focuses**: clicking an already-open file from chat or the file tree focuses its existing tab instead of duplicating it.
- **Preview is read-only & local**: previewing a file NEVER implicitly attaches, uploads, or sends that file to any LLM provider.

## Workspace layout & state boundaries

```text
+-------------------+-----------------------------------+--------------------------------------+
| Folder tree       | Chat transcript                   | Shared right-hand tab strip          |
| (active project   | - Project chat (fixed workspace)  | [sample.pdf] [hello.ts] [preview]    |
|  or collapsed in  |   OR Standalone chat              | ------------------------------------ |
|  standalone mode) | - Filename chips & file links     | Breadcrumbs (scope-aware)            |
|                   | - Tool & approval cards           | ------------------------------------ |
|                   | --------------------------------- | Preview / Source / Isolated Browser  |
|                   | Persistent composer + attachments |                                      |
+-------------------+-----------------------------------+--------------------------------------+
```

### Independent chat contexts (Project vs Standalone)
1. **Project chat**:
   - Permanently bound at creation time to a specific `workspaceId` and canonical `workspaceRoot`.
   - Switching the visible project in the sidebar changes the folder tree, **never** the workspace recorded on an existing chat or its messages.
   - Restoring a saved project chat preserves its recorded `workspaceRoot` so historical file links still resolve against their original workspace even when a different project is currently selected.
2. **Standalone chat**:
   - Has `workspaceId = null` and no implicit folder scope.
   - Switching between standalone chat and project chats preserves each chat's transcript, composer draft, attachments, and active workspace context independently.
   - Can open **only explicitly user-attached files** recorded in that chat's attachment allowlist — never arbitrary local paths emitted by the assistant or tool text.

## File chips, transcript links, and untrusted-input safety

Transcript text (assistant messages and tool output) is treated as **untrusted input** because workspace files or web pages can attempt prompt injection.

- **Supported link forms in chat**:
  - Explicit filename chips emitted from structured tool metadata or user attachments (preferred, carries explicit target path + owning message `workspaceScope`).
  - Markdown file links (`[label](relative/path.ts#L10-L20)` or `[label](file:///...)`) and recognized workspace-relative path references.
- **Deceptive-link protection**:
  - Hovering or focusing a file chip/link MUST display the resolved workspace-relative canonical path (or external domain for `https://` links) so a crafted label like `[README.md](C:\Windows\System32\drivers\etc\hosts)` cannot disguise its true target.
  - External web URLs (`https://`, `http://`) are visually distinguished from local file chips and open in an isolated browser tab (never through local file resolution).
  - Blocked, stale, or out-of-workspace links render an inline/toast error banner showing the error reason (`OUT_OF_WORKSPACE`, `MISSING_FILE`, `STALE_LINK`, `UNATTACHED_STANDALONE_PATH`, `UNSAFE_PATH_SYNTAX`) and **never silently substitute another file**.

## Preview routing by target type

| Target kind | Viewer in right-hand pane | Required behavior |
| --- | --- | --- |
| **PDF** (`.pdf`) | Isolated PDF viewer tab | Page navigation (prev/next/jump + current/total page indicator) and zoom controls (in/out/fit-width/reset) |
| **Code & text** (`.ts`, `.js`, `.py`, `.rs`, `.md`, `.json`, `.yml`, `.ps1`, `.txt`, etc.) | Source viewer tab (shell-rendered, syntax-highlighted, read-only in MVP) | Supports optional line/range anchors (`#L10`, `#L10-L20`, `:10`) by scrolling to and highlighting the target lines |
| **HTML** (`.html`, `.htm`) | Isolated browser tab (NOT source text by default) | Runs as an interactive page under a workspace-scoped isolated origin with zero desktop IPC bridge; optional explicit "View Source" action opens a separate read-only source tab |
| **Folder link** | File explorer (left sidebar) | Reveals and expands that folder inside the owning workspace's file tree (rejected if outside workspace or in standalone chat) |
| **Localhost / Web URL** | Isolated browser tab in the same tab strip | Uses isolated profile outside project folders; URL bar + back/forward/reload controls |

## Breadcrumbs & standalone-chat boundary

To prevent a conflict between breadcrumb parent-folder browsing and standalone chat's strict explicit-attachment scope:

- **Project workspace files**:
  - Breadcrumbs display `WorkspaceName > dir1 > dir2 > filename`.
  - Clicking any ancestor segment (`WorkspaceName`, `dir1`, `dir2`) reveals/browses nearby files inside that folder (via inline sibling picker and/or focusing the folder in the workspace file tree), strictly bounded at `workspaceRoot` (never ascending above `workspaceRoot`).
- **Standalone chat attached files**:
  - Breadcrumbs display a read-only attachment label (`Attached > filename`) with **in-app parent-folder browsing disabled**, preserving the rule that standalone chats can open only explicitly attached files and not arbitrary local paths.
  - If the user wants to inspect sibling files, they explicitly open the folder as a project (establishing a visible project workspace) or use an explicit OS-level action ("Reveal in File Explorer").

## Tab deduplication, focus, and restore (Windows case-insensitivity)

- Every file preview tab is keyed by a deterministic `PreviewTabKey`:
  - **Project file**: `file:<workspaceId>:<canonicalPathLowercase>` (forward-slash normalized, Windows drive letter lowercased, extended `\\?\` prefix stripped after canonicalization).
  - **Standalone attached file**: `standalone-file:<chatId>:<canonicalPathLowercase>`.
  - **HTML source view** (when explicitly opened alongside live preview): `source:<same-key>`.
  - **Browser tab**: `browser:<tabId>` (separate from file tabs, living in the same tab strip).
- Clicking `C:\Repo\README.md`, `c:\repo\readme.md`, or `.\README.md` from either chat or the file tree computes the identical `PreviewTabKey` and **focuses the existing tab** (updating line highlight if an anchor was supplied).
- **Restore**: When restoring a workspace/chat session, re-validate every saved file tab against the canonical path validator before loading content. If a restored file was deleted, moved, or replaced with an out-of-workspace symlink/junction, show a clear stale/error placeholder tab instead of opening a different file.

## Exact Windows path canonicalization & rejection rules

Every file-link click MUST pass through the trusted backend resolver (`resolveMessageFileLink`) in this exact order before opening any viewer or explorer location:

1. **Syntax & dangerous-form rejection (before touching filesystem)**:
   - Reject empty paths, NUL bytes (`\0`), and control characters.
   - Reject **UNC paths** (`\\server\share`, `//server/share`) — touching an untrusted UNC path on Windows can leak NTLM credentials over SMB!
   - Reject **Windows device & raw extended paths** (`\\.\...`, `\\?\...`, `\\?\GLOBALROOT\...`).
   - Reject **drive-relative paths** (`C:foo.txt`, `\foo.txt` without drive letter).
   - Reject **NTFS Alternate Data Streams** (any `:` outside drive letter index `1`, e.g. `notes.txt:hidden:$DATA`).
   - Reject **Windows reserved DOS device names** in any path component (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or without extensions/trailing spaces or dots).
2. **Scope resolution**:
   - **Standalone chat**: Match normalized target strictly against the chat's explicit `attachedFiles` canonical allowlist. Any path not explicitly attached returns `UNATTACHED_STANDALONE_PATH` (never probe arbitrary disk paths).
   - **Project chat**: Read the `workspaceRoot` recorded on the **message's owning chat** (NOT the currently visible project!). Verify `workspaceRoot` still exists and canonicalize it via OS realpath (`GetFinalPathNameByHandleW` / `fs.realpathSync.native`). If missing, return `WORKSPACE_UNAVAILABLE`.
   - Resolve relative paths against `workspaceRoot`; for absolute paths, proceed directly to canonicalization and containment check (do not reject valid absolute paths inside the owning workspace, do reject any absolute path outside it).
3. **Existence & symlink/junction canonicalization**:
   - Check whether the target exists. If missing, return `STALE_LINK` (for restored/historical messages) or `MISSING_FILE` (with no fallback to nearby or same-named files in another project).
   - Canonicalize the target path via OS realpath (`GetFinalPathNameByHandleW` / `fs.realpathSync.native`) so **NTFS symlinks, directory junctions, and mount points** resolve to their real physical destination.
4. **Case-insensitive path-component containment check**:
   - Normalize both canonical `workspaceRoot` and canonical `targetPath` (strip `\\?\` prefix if returned by Win32, convert `\` to `/`, fold case using Windows invariant case-folding).
   - Verify `targetPath === workspaceRoot` (for folder link) OR `targetPath.startsWith(workspaceRoot + "/")`.
   - **Never** use raw `target.startsWith(workspaceRoot)` without a separator boundary, which fails on prefix collisions like `C:\work\app` vs `C:\work\app-secret\file.txt`.
   - If outside `workspaceRoot`, return `OUT_OF_WORKSPACE`.

## Windows acceptance criteria (first vertical slice)

Detailed fixtures live in [`tests/fixtures/`](../../tests/fixtures/README.md) and exact test assertions live in [`docs/contracts/file-reference-and-preview.md`](../contracts/file-reference-and-preview.md):

1. Open Workspace A, restore a chat containing real links, and click:
   - `docs/sample.pdf` → PDF renders beside the same chat with working page navigation (page 1 → page 2) and zoom.
   - `src/hello.ts#L5-L10` → Source viewer renders `hello.ts` with lines 5–10 highlighted; clicking `SRC\HELLO.TS` focuses the exact same tab without creating a duplicate.
   - `web/preview.html` → Interactive HTML renders as a running page in an isolated browser tab (clicking its button updates DOM state; desktop IPC probes report `undefined`), not as raw source text.
2. Switch the visible project sidebar to Workspace B while keeping Workspace A's restored chat open → clicking a link in Workspace A's chat still resolves against Workspace A (NOT Workspace B).
3. Switch to Standalone chat → Workspace A's context remains preserved; standalone chat opens its explicitly attached file, rejects unattached local paths, and disables in-app parent-folder breadcrumb browsing.
4. Click a stale/deleted link (`docs/deleted.pdf`), a traversal link (`../outside-workspace/secret.txt`), a prefix-collision path (`../workspace-a-other/file.txt`), a symlink/junction pointing outside Workspace A, and a UNC path (`\\127.0.0.1\c$\Windows\win.ini`) → every one shows a clear error and opens **zero** unintended files.

## Open items before implementation

- [ ] Confirm whether clicking a folder link inside a restored chat from Workspace A (while Workspace B is currently visible in the sidebar) switches the file explorer to Workspace A or opens a scoped explorer popover for Workspace A.
- [ ] Sign off on [`docs/contracts/file-reference-and-preview.md`](../contracts/file-reference-and-preview.md).

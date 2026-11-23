# Contract: File Reference Resolution & Right-Hand Preview (`file-reference-and-preview`)

- **Status**: Draft v0.1 (ready for integrator review; freeze before splitting implementation)
- **Decision basis**: [`docs/decisions/workspace-ux.md`](../decisions/workspace-ux.md) and [`docs/decisions/browser-host.md`](../decisions/browser-host.md)
- **Acceptance fixtures**: [`tests/fixtures/README.md`](../../tests/fixtures/README.md)

## Core invariants

1. **Workspace binding**: Every chat message records the `ChatWorkspaceBinding` of the chat that produced it. Clicking a file link resolves against the **message's** binding, NEVER the currently selected sidebar project.
2. **Standalone isolation**: Standalone chats (`kind: "standalone"`) may open ONLY files present in their explicit `attachedFileKeys` allowlist. Arbitrary disk paths and in-app parent-folder breadcrumb browsing are rejected.
3. **Read-only local preview**: Opening or focusing a preview tab NEVER attaches, uploads, or sends file content to any OMP provider.
4. **Windows path safety**: All path validation executes in the trusted backend (never in renderer/webview JS), canonicalizing symlinks/junctions via OS realpath (`GetFinalPathNameByHandleW`) and rejecting UNC, device, drive-relative, ADS, reserved DOS device names, and prefix-collision paths.
5. **Single shared tab strip + case-insensitive dedup**: Chat links and file-tree clicks produce identical `PreviewTabKey` values for the same canonical file in the same workspace, focusing the existing tab on repeated clicks.

## Shared data structures (language-neutral TypeScript representation)

```ts
export type ChatWorkspaceBinding =
  | {
      kind: "project";
      workspaceId: string;
      /** Canonical Windows path to workspace root recorded when the chat was created/restored. */
      workspaceRoot: string;
      workspaceDisplayName: string;
    }
  | {
      kind: "standalone";
      chatId: string;
      /** Canonical lowercased paths explicitly attached by the user in this standalone chat. */
      attachedCanonicalPaths: string[];
    };

export interface LineAnchor {
  startLine: number;
  endLine?: number;
}

export interface MessageFileLinkRequest {
  chatId: string;
  messageId: string;
  /** True when the message came from persisted/restored chat history (distinguishes STALE_LINK from MISSING_FILE). */
  isRestoredMessage: boolean;
  /** Binding recorded with the message's owning chat, NOT the currently selected sidebar project. */
  owningBinding: ChatWorkspaceBinding;
  /** Raw path or file:// link clicked by the user (untrusted input from transcript or chip). */
  rawTarget: string;
  anchor?: LineAnchor;
  /** Explicit override when user clicks "View Source" on an HTML file. */
  preferSourceView?: boolean;
}

export type PathResolutionErrorCode =
  | "UNSAFE_PATH_SYNTAX"          // UNC, \\?\, \\.\, drive-relative, ADS (:stream), reserved DOS name, NUL byte
  | "WORKSPACE_UNAVAILABLE"       // Owning workspace root no longer exists on disk
  | "MISSING_FILE"                // File/folder does not exist (live session)
  | "STALE_LINK"                  // File/folder no longer exists (restored session)
  | "OUT_OF_WORKSPACE"            // Target or symlink/junction target escapes owning workspace root
  | "UNATTACHED_STANDALONE_PATH"; // Standalone chat link targets a file not in attachedCanonicalPaths

export type PreviewViewerKind = "pdf" | "source" | "html-isolated-browser" | "folder-explorer";

export interface BreadcrumbSegment {
  label: string;
  /** Workspace-relative path for project workspaces; null when browsing is disabled (standalone chat). */
  browsableRelativePath: string | null;
}

export interface ResolvedPreviewDescriptor {
  /** Deterministic Windows case-insensitive dedup key: e.g. "file:<workspaceId>:<canonicalLower>" */
  tabKey: string;
  viewerKind: PreviewViewerKind;
  canonicalPath: string;
  /** Display path relative to workspace root (project) or bare filename (standalone). */
  displayPath: string;
  breadcrumbs: BreadcrumbSegment[];
  parentBrowsingAllowed: boolean;
  anchor?: LineAnchor;
  /** For html-isolated-browser only: scoped non-file:// isolated origin URL. */
  isolatedPreviewUrl?: string;
}

export type PathResolutionResult =
  | { ok: true; descriptor: ResolvedPreviewDescriptor }
  | { ok: false; code: PathResolutionErrorCode; message: string; displayTarget: string };

export interface SharedTabItem {
  tabKey: string;
  kind: "file-preview" | "browser";
  title: string;
  descriptor?: ResolvedPreviewDescriptor;
  browserUrl?: string;
  browserProfileId?: string;
}
```

## Exact resolution & canonicalization pipeline

1. **Normalize & reject unsafe syntax (no filesystem touch)**:
   - Strip optional `file:///` prefix (decoding percent-encoding cleanly, rejecting non-empty UNC hosts like `file://server/share/...`).
   - Reject NUL/control chars, UNC (`\\server\share`, `//server/share`), extended/device prefixes (`\\?\`, `\\.\`), drive-relative (`C:foo`, `\foo`), NTFS Alternate Data Streams (`:` at any index other than drive letter index `1`), and reserved DOS device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with optional extension/trailing dot or space) in any path segment.
   - Reject anything that resolves to a non-file URI scheme (such as `ms-msdt:`, `cmd:`, `shell:`, `javascript:`) — external `http:`/`https:` links are routed to isolated browser tabs, never passed to the file resolver.
2. **Enforce owning scope**:
   - **Standalone**: Normalize/canonicalize candidate only if it matches an entry already recorded in `owningBinding.attachedCanonicalPaths` (case-insensitive on Windows). Otherwise immediately return `UNATTACHED_STANDALONE_PATH`. Never enable `parentBrowsingAllowed`. Reject folder targets.
   - **Project**: Verify `owningBinding.workspaceRoot` exists and canonicalize it via OS realpath (`GetFinalPathNameByHandleW`). If missing, return `WORKSPACE_UNAVAILABLE`. Resolve relative `rawTarget` against canonical `workspaceRoot`.
3. **Existence & realpath containment**:
   - If target does not exist, return `STALE_LINK` (when `isRestoredMessage` is `true`) or `MISSING_FILE` (when `false`).
   - Resolve target via OS realpath (`GetFinalPathNameByHandleW`) so NTFS symlinks, junctions, and mount points cannot escape containment.
   - Normalize both canonical root and canonical target: strip `\\?\`, normalize `/` separators, trim trailing `/` (except drive root), lowercase for Windows comparison.
   - Require `targetLower === rootLower || targetLower.startsWith(rootLower + "/")` (prevents `C:/work/app` matching `C:/work/app-secret/x`). Otherwise return `OUT_OF_WORKSPACE`.
4. **Classify viewer & build `PreviewTabKey`**:
   - Directory → `folder-explorer`.
   - `.pdf` (case-insensitive) → `pdf`.
   - `.html` / `.htm` (case-insensitive, unless `preferSourceView === true`) → `html-isolated-browser` with workspace-scoped isolated origin URL (never raw `file:///`).
   - Otherwise → `source`.
   - Build `tabKey` using lowercased canonical path so `docs/sample.pdf`, `DOCS\SAMPLE.PDF`, and `.\docs\sample.pdf` always focus the same tab.

## Deterministic Windows acceptance test matrix

Every PR wiring the first runnable Windows desktop app MUST include automated tests covering all rows below using [`tests/fixtures/`](../../tests/fixtures/README.md):

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| `ACC-01` | Restored project chat (Workspace A) clicks `docs/sample.pdf` | Right-hand tab opens PDF beside same chat (chat & composer stay visible); page navigation moves page 1 -> page 2; zoom changes rendered scale; breadcrumbs show Workspace A segments. |
| `ACC-02` | Restored chat clicks `src/hello.ts#L5-L10`, then clicks `SRC\HELLO.TS` | Source viewer opens `hello.ts` with lines 5–10 highlighted; second click focuses the **same** tab (tab count unchanged). |
| `ACC-03` | Restored chat clicks `web/preview.html` | Isolated browser tab renders interactive HTML (NOT source text); clicking interactive counter increments count; page sees `window.ompDesktop === undefined` and `window.ipc === undefined` (no desktop bridge) and isolated non-`file://` origin. |
| `ACC-04` | Switch visible project sidebar from Workspace A to Workspace B, then click `src/hello.ts` in Workspace A's restored chat | Resolves against **Workspace A** (`workspace-a/src/hello.ts`), NOT Workspace B. |
| `ACC-05` | Switch to Standalone chat while Workspace A chat is open | Standalone chat preserves independent context; opens explicitly attached file with `parentBrowsingAllowed = false`; rejects unattached local file (`UNATTACHED_STANDALONE_PATH`); returning to Workspace A preserves its context. |
| `ACC-06` | Click stale/missing link (`docs/deleted.pdf`) in restored chat | Returns `STALE_LINK` error UI; opens zero files and does not fall back to another file. |
| `ACC-07` | Click out-of-workspace traversal (`../outside-workspace/secret.txt`), prefix-collision path (`../workspace-a-sibling/file.txt`), NTFS symlink/junction pointing to `outside-workspace/secret.txt`, UNC path (`\\127.0.0.1\c$\Windows\win.ini`), ADS (`src/hello.ts:hidden`), and reserved name (`CON`) | Every case fails with `OUT_OF_WORKSPACE` or `UNSAFE_PATH_SYNTAX`; zero unintended files opened; sentinel string `OUTSIDE_WORKSPACE_SENTINEL_DO_NOT_OPEN` never appears in UI. |
| `ACC-08` | Preview any file from chat | Zero provider/LLM prompt or implicit attachment requests emitted to OMP adapter. |

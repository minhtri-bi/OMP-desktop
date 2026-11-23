# Acceptance Fixtures

Isolated, static fixtures for the Windows click-to-preview acceptance matrix defined in [`docs/contracts/file-reference-and-preview.md`](../../docs/contracts/file-reference-and-preview.md).

Tests MUST treat these fixtures as read-only or copy them into an isolated temporary directory (for example when creating dynamic NTFS symlinks or directory junctions on Windows during `ACC-07`).

## Layout

| Path | Purpose |
| --- | --- |
| `workspace-a/docs/sample.pdf` | Valid 2-page PDF for page navigation (1 → 2) and zoom checks (`ACC-01`) |
| `workspace-a/src/hello.ts` | Source code file for source viewer, `#L5-L10` highlight, and case-insensitive tab dedup (`ACC-02`, `ACC-04`) |
| `workspace-a/web/preview.html` + `preview.js` | Interactive HTML page with a counter button and desktop-bridge isolation probes (`ACC-03`) |
| `workspace-b/notes.md` | Second project workspace used to verify project switching does not rebind an open chat's links (`ACC-04`) |
| `workspace-a-sibling/file.txt` | Prefix-collision fixture (`workspace-a` vs `workspace-a-sibling`) (`ACC-07`) |
| `outside-workspace/secret.txt` | Out-of-workspace sentinel (`OUTSIDE_WORKSPACE_SENTINEL_DO_NOT_OPEN`) for traversal and symlink/junction escape rejection (`ACC-07`) |
| `restored-chat.sample.json` | Sample restored project chat transcript containing valid, stale, and out-of-workspace links (`ACC-01`–`ACC-07`) |

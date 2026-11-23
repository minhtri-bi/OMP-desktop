# Decision: Windows Desktop & Browser Host (`browser-host`)

- **Status**: Accepted (**Option A — Electron + `WebContentsView`**, default-blocked external network on local HTML previews with per-tab opt-in toggle)
- **Contract companion**: [`docs/contracts/file-reference-and-preview.md`](../contracts/file-reference-and-preview.md)

## Problem statement

OMP Desktop is a Windows-first workspace that keeps chat and its composer visible while opening file previews (PDF with page navigation and zoom, code/text source viewer, interactive local HTML, localhost previews) and visible browser tabs in one shared right-hand tab strip.

Hard security and UX constraints from [`.omp/AGENTS.md`](../../.omp/AGENTS.md) and [`docs/design.md`](../design.md):
1. **No desktop bridge in web content**: embedded pages, interactive local HTML, and document previews MUST NOT have access to desktop IPC, Node/Rust/WinRT bridges, shell, or arbitrary workspace files.
2. **Per-workspace / per-preview origin isolation**: local HTML from Workspace A MUST NOT read cookies/storage from Workspace B, the desktop shell, or arbitrary local files (`file://` with file access is forbidden).
3. **Browser profiles outside project folders**: never store browser profile data inside any workspace and never borrow the user's personal Edge/Chrome profile.
4. **Dangerous URI scheme blocking**: block untrusted navigation to `file:`, `javascript:` top-level, and Windows OS protocol handlers (`ms-msdt:`, `cmd:`, `shell:`, `powershell:`, custom app schemes) unless explicitly confirmed by the user.
5. **Windows airspace / overlay fidelity**: shell UI dropdowns, modals, command palettes, tooltips, and resizable split panes must work cleanly alongside embedded browser/PDF tabs on Windows.
6. **Real Windows UI acceptance testing**: automated end-to-end tests must click real links in a restored chat and observe PDF, source, and interactive HTML rendering beside the same chat on Windows.

## Host comparison (Windows-first)

| Criterion | Option A: **Electron** (`WebContentsView` + isolated `session.fromPartition`) | Option B: **Tauri v2** (Rust + Windows WebView2 multi-webview) | Option C: **WinUI 3 / WPF + WebView2** (C# / .NET + `CoreWebView2`) |
| --- | --- | --- | --- |
| **Shared preview & browser tab engine** | Bundled deterministic Chromium (`WebContentsView` per preview/browser tab) | OS-installed Edge WebView2 (`CoreWebView2` child webviews) | OS-installed Edge WebView2 (`CoreWebView2`) |
| **PDF (page nav + zoom)** | Built-in Chromium PDFium viewer in isolated `WebContentsView` (or sandboxed `pdf.js`); deterministic across Windows versions | Edge WebView2 built-in PDF viewer (varies slightly with OS Edge updates) or `pdf.js` | Edge WebView2 built-in PDF viewer or `pdf.js` |
| **Interactive local HTML & origin isolation** | Scoped custom scheme (`omp-preview-<workspaceId>://`) or ephemeral loopback server per workspace + dedicated `session.fromPartition('persist:browser-...' / 'preview-...')` with `sandbox: true, contextIsolation: true, nodeIntegration: false, preload: undefined` | Separate `CoreWebView2Environment` (`userDataFolder` outside projects) + `SetVirtualHostNameToFolderMapping` per workspace + `AreHostObjectsAllowed = false`, `IsWebMessageEnabled = false`; multi-webview lifecycle in Tauri v2 still needs manual bounds/visibility sync | Separate `CoreWebView2Environment` + `SetVirtualHostNameToFolderMapping` + disabled host objects/web messages; full Win32 control |
| **Windows airspace / Z-order** | **Strong**: shell UI and child `WebContentsView` share Chromium compositor lifecycle cleanly (still keep shell modals above child views or hide/reorder views cleanly via Electron view stacking) | **Weak / High friction**: child WebView2 HWNDs sit *above* the HTML shell WebView2 HWND on Windows, clipping HTML dropdowns, context menus, command palettes, and modals unless manually hidden or rebuilt as native popups | **Good for native controls** (WinUI 3 `WebView2` / `ContentDialog`), but requires building the entire chat, markdown, diff, and code-viewer UI in XAML or embedding yet another WebView2 |
| **Desktop bridge isolation** | Shell uses one isolated preload/IPC surface; preview & browser `WebContentsView`s use a completely separate Chromium `Session` partition with **zero preload** and **zero IPC handlers** | Shell WebView2 has Tauri IPC (`__TAURI_INTERNALS__`); preview WebView2s must be created in a separate WebView2 environment with no Tauri IPC injection (verify Tauri's multi-webview does not inject IPC scripts into untrusted origins) | Full separation: C# host never registers host objects or `WebMessageReceived` on preview `CoreWebView2` instances |
| **Profile & storage isolation** | Dedicated `userData` subdirs under `%LOCALAPPDATA%\OMPDesktop\browser-profiles\` via `session.fromPartition(...)` | Dedicated `CoreWebView2Environment` `userDataFolder` under `%LOCALAPPDATA%\OMPDesktop\browser-profiles\` | Dedicated `CoreWebView2Environment` `userDataFolder` under `%LOCALAPPDATA%\OMPDesktop\browser-profiles\` |
| **Windows Job Object (`omp.exe` cleanup)** | Supported via small native Win32 N-API addon or Rust/C# sidecar helper (or lightweight helper launcher) | Native in Rust (`windows-sys` / `CreateJobObjectW`) | Native in C# (`P/Invoke` `CreateJobObject`) |
| **Automated Windows UI acceptance testing** | **Strongest**: Playwright supports Electron natively (`_electron.launch`) for clicking real chat links and asserting PDF/source/HTML tabs in Windows CI | WebDriver (`tauri-driver` / `msedgedriver`) on Windows has known flakiness with multi-webview and PDF frames | WinAppDriver / FlaUI + CDP over WebView2 (higher setup cost) |
| **Install size / memory** | Larger binary (~100+ MB bundled Chromium) and higher baseline RAM | Small binary (~10–20 MB; reuses OS WebView2) | Medium (.NET runtime; reuses OS WebView2) |
| **Language alignment with OMP** | TypeScript/Node (matches OMP's TypeScript RPC types directly, zero schema translation drift) | Rust backend + TypeScript frontend | C# backend + XAML/TypeScript frontend |

## Recommendation: **Option A — Electron (`WebContentsView`)** (with Option B — Tauri v2 as documented alternative)

**Why Electron is the recommended default for OMP Desktop's first Windows release:**
1. **Hard isolation without OS WebView2 airspace bugs**: Electron's `WebContentsView` + separate `session.fromPartition(...)` cleanly separates the desktop shell from untrusted previews and visible browser tabs with zero preload and zero IPC bridge, while giving deterministic Chromium behavior for PDFium, interactive HTML, and DevTools across Windows 10/11 and GitHub Actions `windows-2022` runners.
2. **Zero-friction Windows UI acceptance tests**: Playwright's first-class Electron support directly satisfies [`README.md`](../../README.md#core-interaction-open-files-from-chat)'s requirement to click real links in a restored chat and verify PDF, source, and interactive HTML beside the same chat in Windows CI.
3. **Single-language contract alignment**: OMP's own RPC protocol (`rpc-types.ts`, `RpcFrameDecoder`) is TypeScript; sharing strict TypeScript types across the OMP adapter, main process path validator, and renderer UI reduces contract drift.

**When to pick Option B (Tauri v2) instead:**
- Choose Tauri v2 only if minimizing installer size / idle RAM outweighs the cost of managing Windows WebView2 HWND airspace (native menus/overlays for any UI overlapping the preview pane) and writing WebDriver + native Win32 tests for multi-webview preview isolation.

## Mandatory preview & browser security architecture (host-independent)

Whichever host the owner approves, every preview and browser view MUST enforce all of the following invariants:

### 1. Strict separation of shell vs preview/browser processes & storage
- **Desktop shell view**: renders folder tree, chat transcript, composer, tab strip, breadcrumbs, and code/text source viewer. Holds the **only** IPC channel to the trusted main/native backend.
- **Preview & browser views** (interactive HTML, localhost preview, PDF viewer, visible web browser):
  - Run in a **separate browser partition / `CoreWebView2Environment`** whose storage lives under `%LOCALAPPDATA%\OMPDesktop\browser-profiles\<profile-id>` (never inside a project folder, never sharing the user's personal Edge/Chrome profile).
  - Have **zero preload scripts**, **zero host objects**, **zero web-message bridges**, `sandbox = true`, `contextIsolation = true`, `nodeIntegration = false`.
  - Are treated as completely untrusted; compromising a preview tab MUST NOT grant IPC access to the OMP adapter, filesystem APIs, or shell cookies/storage.

### 2. Local interactive HTML serving & origin isolation
- **Never** open local interactive HTML via raw `file:///` with `allowFileAccessFromFileURLs` or broad filesystem access.
- Serve each local HTML preview from a **workspace-scoped isolated origin**:
  - Example (Electron custom protocol or scoped loopback): `omp-preview-<opaqueWorkspaceToken>://workspace/<relative-path>` (or ephemeral `127.0.0.1:<port>` with per-preview random Host/token) whose backend handler runs the **same canonical workspace containment validator** as [`docs/contracts/file-reference-and-preview.md`](../contracts/file-reference-and-preview.md) on every subresource request (`.js`, `.css`, images, `fetch()`).
  - Any relative subresource attempting `../` traversal, symlink/junction escape outside the owning workspace, or access to another workspace returns HTTP `403`.
  - **Standalone chat HTML attachment**: serve **only the explicitly attached file(s)** (no implicit sibling-folder read access!).
  - **Cross-origin / exfiltration policy**:
    - Disallow credentialed cross-origin reads against `localhost` services from local HTML previews by using a unique non-localhost origin per workspace.
    - Document and surface a clear default network policy for local HTML previews (recommended default: allow same-workspace subresources; block outbound remote network requests from untrusted local HTML previews unless the user explicitly toggles "Allow network for this preview" — or gate via explicit banner — to prevent a malicious workspace HTML file from reading sibling workspace files and exfiltrating them via `fetch()`).

### 3. PDF rendering & active content
- Render PDFs in an isolated preview view (Chromium PDFium or sandboxed `pdf.js` with `isEvalSupported: false` and PDF JavaScript disabled) supporting **page navigation and zoom**.
- Intercept all link clicks inside PDFs via navigation guards (`will-navigate` / `setWindowOpenHandler` / `NavigationStarting`):
  - Never auto-launch OS protocol handlers or `file://` URLs.
  - Open external `https://` links only via explicit user click into an isolated browser tab (or OS default browser on explicit action).

### 4. Navigation & URI scheme guard (all preview & browser views)
- Allowlist only `https:`, `http:` (for visible browser / localhost preview), and the scoped preview scheme (`omp-preview-<token>:`).
- Hard-block `file:`, `javascript:` (top-level), `data:` (top-level), `vbscript:`, `ms-msdt:`, `cmd:`, `shell:`, `powershell:`, `smb:`, `ftp:`, and any unregistered OS protocol handler.
- Intercept `window.open` / `target="_blank"` to open inside a new isolated browser tab (never spawning an unbounded privileged window with inherited preload).

### 5. Native Windows process supervision
- Regardless of Electron vs Tauri vs WinUI 3, the trusted backend MUST manage `omp.exe` children under a Win32 Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) so abnormal app termination cannot leak live OMP or shell processes.

## Accepted decision

- [x] Approved **Option A (Electron + `WebContentsView`)** (owner decision).
- [x] Confirmed default outbound network policy for **local interactive HTML previews**: block external network by default with a per-tab opt-in toggle; localhost previews and visible browser tabs allow normal HTTP/HTTPS.

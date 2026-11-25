# Decision: OMP Runtime Integration (`omp-runtime`)

- **Status**: Accepted (verified against pinned OMP `v19.1.1` source/docs and Windows CI RPC probe; default `--approval-mode always-ask`)
- **Pinned runtime**: `can1357/oh-my-pi` `v19.1.1` (`omp-windows-x64.exe`, SHA-256 `4e18f472975bb87f9b1992f1d5981b9a1403fd559cdb3eb96f1f1a7d709096ef`)
- **Contract companion**: [`docs/contracts/omp-adapter.md`](../contracts/omp-adapter.md)
- **Reproducible probe**: [`scripts/probe-omp-rpc.ps1`](../../scripts/probe-omp-rpc.ps1)

## Decision summary

OMP Desktop runs the installed `omp` binary as an out-of-process JSONL RPC child (`omp --mode rpc-ui --approval-mode always-ask`) behind a dedicated adapter. The desktop never scrapes TUI output, never reimplements the agent loop, and never copies OMP provider credentials into desktop-managed storage.

1. **Always negotiate RPC Protocol v2** immediately after the initial `ready` frame (`negotiate_protocol` with `protocolVersion: 2`) to obtain lossless `rpc_chunk` framing up to 64 MiB instead of v1's 1 MiB truncation/elision ceiling.
2. **Use plain `--mode rpc-ui` (without `--no-ui`)** so both extension approval prompts and interactive tool dialogs (`ask` / `form`) flow through `extension_ui_request` / `extension_ui_response` while `PI_NO_PTY=1` disables raw PTY assumptions.
3. **Pass `--approval-mode always-ask` (or user-selected non-yolo mode) explicitly**: OMP `v19.1.1` defaults `tools.approvalMode` to `yolo` (auto-approving `read`, `write`, `exec`), which violates this project's requirement for explicit approval of external effects.
4. **Isolate process CWD and lifecycle**: bind each workspace chat to its own OMP process whose `cwd` is the workspace root, bind standalone chat to a dedicated empty directory outside `%USERPROFILE%` (for example `%LOCALAPPDATA%\OMPDesktop\standalone-cwd`), and attach every spawned `omp.exe` to a Windows Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) to prevent orphaned processes on app crash.
5. **Treat `extension_ui_request (method: "form")` HTML as untrusted input**: parse form controls into native/declarative UI components rather than injecting raw `html` into the desktop shell DOM.

## Protocol & transport surface (`omp/19.1.1`)

Verified against `packages/coding-agent/src/modes/rpc/rpc-mode.ts`, `rpc-types.ts`, and `docs/rpc.md` at tag `v19.1.1`:

- **Transport**: Custom newline-delimited JSON (JSONL) over UTF-8 (no BOM) `stdin`/`stdout` — **not** JSON-RPC 2.0.
- **Startup handshake**:
  - Process emits `{ "type": "ready", "protocolVersion": 1, "supportedProtocolVersions": [1, 2], "maxFrameBytes": 1048576, "maxReassembledFrameBytes": 67108864, "supportsBashExcludeFromContext": true }`.
  - Adapter sends `{ "id": "...", "type": "negotiate_protocol", "protocolVersion": 2 }`.
  - Under v2, frames exceeding 1 MiB arrive as consecutive `{ "type": "rpc_chunk", "chunkId", "index", "count", "byteLength", "data" }` base64 segments. Adapter MUST reject interleaved/interrupted chunks, enforce `maxReassembledFrameBytes`, decode strict UTF-8, and parse one JSON object.
- **Streaming & history retention**:
  - `agent_end.messages` may be compacted to omit messages already emitted in `message_end` frames (with `messageCount` preserved). The adapter MUST retain streamed `message_end` frames as the canonical live transcript.
  - Paginated history reads use `get_messages_page` (`limit: 1..256`, default `100`, 768 KiB target budget). Handle machine-readable error codes `session_busy` (streaming/compacting) and `stale_cursor` (session mutated between pages) without string-matching error messages.
- **Error recovery**:
  - Malformed inbound JSON produces `{ "type": "response", "command": "parse", "success": false, "error": "..." }` and leaves the RPC loop alive.
  - Unknown commands echo `id` with `success: false`.
- **Clean shutdown**:
  - Closing `stdin` rejects pending extension UI / host tool / host URI requests, drains accepted commands, flushes pending `stdout` (including backpressure temp-spool), and exits `0` (or `1` on session-persistence failure).
  - The adapter MUST keep draining `stdout` to EOF after closing `stdin` so the child cannot deadlock waiting on a full pipe.

## `--mode rpc` vs `--mode rpc-ui` & approval surfaces

| Startup flags | Extension UI (`ctx.hasUI`, tool approvals) | Tool UI (`ask` / `form`) | `PI_NO_PTY` | Desktop suitability |
| --- | --- | --- | --- | --- |
| `--mode rpc --no-ui` | Disabled (approvals fail closed) | Disabled | Unset | Unsuitable for interactive desktop |
| `--mode rpc` | Enabled | Disabled (except host-issued `login`) | Unset | Incomplete (missing tool dialogs) |
| `--mode rpc-ui --no-ui` | Disabled (approvals fail closed) | Enabled | `1` | Unsuitable (approvals fail closed) |
| **`--mode rpc-ui`** | **Enabled** | **Enabled** | **`1`** | **Recommended for OMP Desktop** |

Key approval and UI behaviors verified in `docs/approval-mode.md` and `docs/rpc.md`:

- **Default approval mode risk**: OMP defaults `tools.approvalMode` to `yolo`. OMP Desktop MUST explicitly launch with `--approval-mode always-ask` (or `always-ask-cached` if the user enables cached grants) unless the user explicitly changes the approval setting.
- **Approval modes available**:
  - `always-ask`: auto-approves `read`; prompts for `write` and `exec`.
  - `always-ask-cached`: prompts for ungranted file reads, `write`, and `exec`; in RPC mode, OMP presents both session and persistent grant lifetimes as explicit choices (`Approve File`, `Always Approve File`, etc.) stored in OMP's `approval-cache.db`.
  - `write`: auto-approves `read` and `write`; prompts for `exec`.
  - `yolo`: auto-approves all tiers (except explicit tool `deny`/`prompt` policies and `tools.restrictedFolders`).
- **Interactive UI methods** (`type: "extension_ui_request"`):
  - Response-bearing: `select`, `confirm`, `input` (respect `secret: true` masking), `editor`, `ask` (opt-in via `set_ask_dialog`), `form` (no opt-in; carries raw HTML `<form>` — must be parsed safely, never rendered with `innerHTML` inside the desktop shell, and always answered or explicitly cancelled to avoid blocking `ask` in plan mode).
  - Fire-and-forget / control: `cancel` (`targetId`), `notify`, `setStatus`, `setWidget`, `setTitle` (suppressed unless `PI_RPC_EMIT_TITLE=1`), `set_editor_text`, `open_url` (OAuth login flow; prefer `launchUrl` when present).
- **Host extensibility hooks** (available for later milestones): `set_host_tools` (`host_tool_call` / `host_tool_result`) and `set_host_uri_schemes` (`host_uri_request` / `host_uri_result`).

## Session, CWD isolation, and Windows process lifecycle

1. **Process topology**:
   - **Project chats**: Spawn one OMP RPC process per active workspace root (`cwd = canonicalWorkspaceRoot`). OMP loads `<cwd>/.omp/config.yml` without ancestor walk-up, so `cwd` MUST always be the workspace root. Multiple chats within the same workspace can switch via `open_session` / `switch_session` or run separate processes if concurrent turns are required; MVP starts with one process per active chat scope to keep cancellation and workspace isolation unambiguous.
   - **Standalone chat**: Spawn with `cwd = %LOCALAPPDATA%\OMPDesktop\standalone-cwd` (a dedicated empty directory with no `.omp/` or `AGENTS.md` ancestor under `%USERPROFILE%`? Note: OMP's `agents-md` discovery walks up to the home boundary when under `%USERPROFILE%`, so `%LOCALAPPDATA%` sits under `%USERPROFILE%`; check whether `%PROGRAMDATA%` or an explicit `--no-extensions` / isolated git-root sentinel inside `%LOCALAPPDATA%\OMPDesktop\standalone-cwd` stops ancestor walk-up!). Specifically, placing an empty marker `.git` directory or dedicated `--session-dir` stops OMP's repo-root walk-up at the standalone directory — verify this behavior in Slice 1's integration harness before shipping standalone chat!
2. **Protocol defaults (`protocolDefault: ["rpc", "acp"]`)**:
   - In RPC mode, OMP applies neutral host defaults for task isolation/execution, memory, advisor, and async/auto-background settings, while explicit project `.omp/config.yml` and global config remain authoritative.
   - `PI_NO_TITLE=1` is automatically set in RPC modes (no surprise background LLM calls for title generation).
3. **Windows Job Object cleanup**:
   - On Windows, child processes spawned by `omp.exe` (such as PowerShell/bash tool invocations) can outlive a crashed desktop app.
   - The native host launcher MUST create a Win32 Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and assign every spawned `omp.exe` process handle to it immediately upon creation.
   - Normal shutdown: send `abort` if streaming, close `stdin`, drain `stdout` with a bounded timeout (e.g. 5 s), then terminate the Job Object if still alive.

## Unsupported or restricted operations in RPC mode

| Capability | Behavior in OMP `v19.1.1` RPC | Desktop handling |
| --- | --- | --- |
| Starting RPC with zero configured models / credentials | Fails closed before `ready`: `main.ts` (`!isInteractive && !session.model`) exits `1` with `No default model selected` | Detect exit code `1` before `ready` as `NO_CONFIGURED_MODEL` and guide the user to run `omp /login`, set an API key, or configure `models.yml` (do not assume RPC `login` can bootstrap an unconfigured install) |
| `@file` CLI arguments | Rejected in RPC mode | Pass explicit user attachments via prompt payload / host contract, never CLI `@file` |
| Terminal-only UI (component factories, custom headers/footers/editors, raw terminal input, autocomplete, TUI theme switching, tool expansion) | Unsupported (`getEditorText()` returns `""`) | Render native desktop UI from structured RPC events |
| Pre-URL secret login prompts | Unsupported in RPC `login` | Surface provider status and let user authenticate via OAuth `open_url` or `omp` CLI for unsupported flows |
| `get_messages_page` while streaming/compacting | Fails with `code: "session_busy"` | Load history before streaming or fall back cleanly on `session_busy` / `stale_cursor` |
| Auto session title generation | Disabled (`PI_NO_TITLE=1`) | Derive UI tab title locally or call `set_session_name` on user rename |

## Reproducible zero-cost verification evidence

Run locally on Windows PowerShell with `omp` on `PATH` (no API key, no prompt, no paid call):

```powershell
.\scripts\probe-omp-rpc.ps1
```

The probe verifies on pinned `omp-windows-x64.exe` `v19.1.1`:
1. **Unconfigured install gate**: with an empty isolated `PI_CODING_AGENT_DIR` and no API keys, `--mode rpc` exits non-zero before `ready` with `No default model selected`.
2. **`--mode rpc`** (with an isolated offline dummy `models.yml` using `auth: none` and unreachable loopback `http://127.0.0.1:1/v1`, zero prompts sent): `ready` frame (`protocolVersion: 1`, `supportedProtocolVersions` contains `2`, `maxFrameBytes: 1048576`, `maxReassembledFrameBytes: 67108864`), `negotiate_protocol` v2, `get_state` (`isStreaming: false`), `get_available_commands`, `get_messages_page`, malformed JSON recoverable `command: "parse"` error followed by successful `get_state`, and clean `stdin` EOF exit code `0`.
3. **`--mode rpc-ui`** (same isolated offline dummy model, zero prompts sent): `ready` frame, `negotiate_protocol` v2, `get_state`, and clean `stdin` EOF exit code `0`.

The same zero-cost probe runs automatically on Windows (`windows-2022`) in [`.github/workflows/verify.yml`](../../.github/workflows/verify.yml).

## Open items before implementation

- [x] Standalone-chat CWD ancestor walk-up boundary enforced by creating an empty `.git` sentinel inside `standalone-cwd` alongside a dedicated per-chat `--session-dir`.
- [x] Default approval mode locked to `--approval-mode always-ask` (owner decision).
- [x] Signed off on [`docs/contracts/omp-adapter.md`](../contracts/omp-adapter.md).

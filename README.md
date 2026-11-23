# OMP Desktop

A Windows-first workspace for local folders, standalone chat, project chat, and an embedded browser. OMP is the runtime, not another feature to rebuild. This initial commit sets up local collaboration; no app framework or dependencies have been selected.

## Core interaction: open files from chat

Match the Antigravity interaction: clicking a filename chip or file link in chat opens the real file in a tab in the right-hand pane. Keep chat and its composer visible. Use one tab strip for file previews and browser tabs; a second click on an already open file focuses its tab. Show the file's path as breadcrumbs, with the parent folder available for browsing nearby files.

- PDF renders in the pane with page navigation and zoom. Code and text open in a source viewer. HTML opens as a running page in an isolated browser tab, not as source text. A folder link opens that location in the file explorer.
- Resolve a link against the workspace that owns its message, not whichever project is currently selected. Standalone chats can open explicitly attached files, not arbitrary local paths. Show a clear error for missing files or links outside the allowed scope. Previewing a file does not attach or send it to a provider.
- A Windows acceptance check must click real links in a restored chat and observe the PDF, source, and interactive HTML beside the same chat. Verify that a stale link and an out-of-workspace link do not open a different file.

## Start working

- Read [project rules](.omp/AGENTS.md) and the primary checkout's local `.omp/STATUS.md`. The status file is intentionally ignored by Git. Create it in the primary checkout if starting from a fresh clone; do not copy it into linked worktrees.
- Assign one owner per task with this contract: `Goal | base SHA | branch and absolute worktree | literal write paths | read-only dependencies | expected behavior | exact check`. New paths need an updated claim before editing.
- The integrator owns shared interfaces, root build files, and integration. Keep dependent tasks queued until their required contract lands on an agreed base.

From the primary checkout, after the initial commit, create each assigned worktree from the agreed base. Example when `main` is that base:

```powershell
git worktree add -b work/omp-rpc ..\omp-desktop-omp-rpc main
Set-Location ..\omp-desktop-omp-rpc
omp
```

Open a separate session from each worktree. A standalone `task` subagent does not automatically get its own Git worktree. Use read-only subagents for parallel research from the primary checkout; use dedicated worktree sessions for implementation. Include the full assignment and project rules in any delegated prompt.

### Optional: OMP team dispatch

From the primary checkout, run `ompt`, then enter `/team up 2` in its composer to create a pool without starting assignments. Ask the master to draft scoped tasks from the contract above. Review the draft via `/team review <plan-id>` in the composer. Use `/team run <plan-id>` only if you want bounded checking and retries and have reviewed every check command. Those team checks start in the team's project directory; they must explicitly target the intended worktree when the output is there.

The team launcher does not create Git worktrees. Use primary-checkout team workers for read-only tasks (`paths: []`); run implementation in the assigned worktree session. Do not work around a team path guard to edit another checkout. No task, check, merge, or publication is authorized by a draft or a worker report.

## Suggested first assignments

These are independent proposals, not active claims. Each agent owns the evidence and a single written decision. Start implementation after the integration owner agrees on the shared contract.

| Slice | Candidate write scope | Acceptance |
| --- | --- | --- |
| OMP runtime | `docs/decisions/omp-runtime.md` | Probe installed OMP RPC without a paid prompt. Record the version, session/stream/approval surfaces, unsupported operations, and reproducible evidence. |
| Desktop and browser host | `docs/decisions/browser-host.md` | Compare Windows hosts for the shared preview pane. Explain how to render PDF and interactive local HTML, isolate browser profiles, and keep page content away from app IPC. |
| Folder and chat workflow | `docs/decisions/workspace-ux.md` | Specify file chips, the side-by-side preview, breadcrumb navigation, tab focus/restore, standalone/project chats, and exact workspace link resolution. |

The first integrated path must open a folder and display files from its chat in the right-hand pane. Switching to standalone chat must preserve each chat's own context. Both use the same OMP adapter. Verify this flow in the running Windows app before broadening the surface.

## Verify the bootstrap

These commands read local settings; they do not launch a worker or make a model request. Run them from the project root with OMP on `PATH`:

```powershell
omp --version
omp config list --scope=project --json
omp config get task.isolation.apply --json
omp config get task.speculativeLaunch --json
git check-ignore .omp/STATUS.md
```

Both effective task settings must be `false`. The first disables automatic application by the built-in isolated task flow; the second disables speculative task starts. Neither setting changes permissions or OMP team approval. `git check-ignore` must print `.omp/STATUS.md`. There is no application build or app test yet.

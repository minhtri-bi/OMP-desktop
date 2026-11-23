# OMP Desktop

A Windows-first workspace for local folders, standalone chat, project chat, and an embedded browser. OMP is the runtime, not another feature to rebuild. See the [design mind map](docs/design.md) for scope and decision order. No app framework or dependencies have been selected.

## Core interaction: open files from chat

Match the Antigravity interaction: clicking a filename chip or file link in chat opens the real file in a tab in the right-hand pane. Keep chat and its composer visible. Use one tab strip for file previews and browser tabs; a second click on an already open file focuses its tab. Show the file's path as breadcrumbs, with the parent folder available for browsing nearby files.

- PDF renders in the pane with page navigation and zoom. Code and text open in a source viewer. HTML opens as a running page in an isolated browser tab, not as source text. A folder link opens that location in the file explorer.
- Resolve a link against the workspace that owns its message, not whichever project is currently selected. Standalone chats can open explicitly attached files, not arbitrary local paths. Show a clear error for missing files or links outside the allowed scope. Previewing a file does not attach or send it to a provider.
- A Windows acceptance check must click real links in a restored chat and observe the PDF, source, and interactive HTML beside the same chat. Verify that a stale link and an out-of-workspace link do not open a different file.

## Start working

- Read [project rules](.omp/AGENTS.md) and the primary checkout's existing local `.omp/STATUS.md`, if present. That ledger records ownership only, not feature progress; never commit or copy it.
- Assign one owner per task with this contract: `Goal | base SHA | branch and absolute worktree | literal write paths | read-only dependencies | primary skill | expected and preserved behavior | exact check`. Follow the [required skill routes](.omp/AGENTS.md#required-skill-routing). New paths need an updated claim before editing.
- The integrator owns shared interfaces, root build files, and integration. Keep dependent tasks queued until their required contract lands on an agreed base.

From the primary checkout, put each linked worktree under the repository's ignored `.worktrees\` directory. Use an unused path, an agreed base SHA, and a unique task branch. Example when `main` is that base:

```powershell
git check-ignore -- .worktrees/omp-rpc/
if ($LASTEXITCODE -ne 0) { throw 'The worktree path must be ignored.' }
if (Test-Path -LiteralPath .worktrees/omp-rpc) { throw 'The worktree path already exists.' }
git worktree add -b work/omp-rpc .worktrees/omp-rpc main
if ($LASTEXITCODE -ne 0) { throw 'Could not create the assigned worktree.' }
Set-Location .worktrees\omp-rpc
omp
```

Run all edits, builds, and tests from the assigned checkout, not `main`. This is checkout isolation, not an OS permission boundary. Do not remove or move another task's checkout.

Open a separate session from each worktree. A standalone `task` subagent does not automatically get its own Git worktree. Use read-only subagents for parallel research from the primary checkout; use dedicated worktree sessions for implementation. Include the full assignment and project rules in any delegated prompt.

### Optional: OMP team dispatch

From the primary checkout, run `ompt`, then enter `/team up 2` in its composer to create a pool without starting assignments. Ask the master to draft scoped tasks from the contract above. Review the draft via `/team review <plan-id>` in the composer. Use `/team run <plan-id>` only if you want bounded checking and retries and have reviewed every check command. Those team checks start in the team's project directory; they must explicitly target the intended worktree when the output is there.

The team launcher does not create Git worktrees. Use primary-checkout team workers for read-only tasks (`paths: []`); run implementation in the assigned worktree session. Do not work around a team path guard to edit another checkout. No task, check, merge, or publication is authorized by a draft or a worker report.

## Progress and code graph

Open OMP in the designated coordinator worktree. Use `project_roadmap` to track milestones, dependencies, blockers, and observed checks; only the coordinator updates it. `/roadmap status` shows current progress, and `/roadmap view` opens or prints the path of the offline view. Start a roadmap in that checkout if none exists. The ignored `.omp/roadmap/` state is bound to its checkout path, so keep that worktree while the roadmap is active. Do not create a second board or commit its generated JSON/HTML.

Use the existing Graphify integration for static code impact, not for judging task completion:

1. Read `skill://graphify-local` and check `/roadmap code status`.
2. Run `/roadmap code index` on request in the intended worktree. OMP uses local, code-only extraction and keeps the graph cache outside the checkout. Do not install Graphify, hooks, watchers or MCP from this repo.
3. Link relevant paths or indexed symbols to the roadmap task. Reindex in the checkout being reviewed after relevant source changes. Treat absent, stale, unsupported, and ambiguous results as limitations. Confirm definitions and affected callers with source or LSP.

Keep private progress receipts and generated graphs local. The PR is the review record, not a mirror of the roadmap.

## Suggested first assignments

These are independent proposals, not active claims. Each agent owns the evidence and a single written decision. Start implementation after the integration owner agrees on the shared contract.

| Slice | Candidate write scope | Acceptance |
| --- | --- | --- |
| OMP runtime | `docs/decisions/omp-runtime.md` | Probe installed OMP RPC without a paid prompt. Record the version, session/stream/approval surfaces, unsupported operations, and reproducible evidence. |
| Desktop and browser host | `docs/decisions/browser-host.md` | Compare Windows hosts for the shared preview pane. Explain how to render PDF and interactive local HTML, isolate browser profiles, and keep page content away from app IPC. |
| Folder and chat workflow | `docs/decisions/workspace-ux.md` | Specify file chips, the side-by-side preview, breadcrumb navigation, tab focus/restore, standalone/project chats, and exact workspace link resolution. |

The first integrated path must open a folder and display files from its chat in the right-hand pane. Switching to standalone chat must preserve each chat's own context. Both use the same OMP adapter. Verify this flow in the running Windows app before broadening the surface.

## Verification and delivery

Run the same harness check as CI from PowerShell with `omp` and Git on `PATH`:

```powershell
.\scripts\check-harness.ps1
```

The [Verify workflow](.github/workflows/verify.yml) runs on Windows for PRs targeting `main`. It verifies the SHA-256 of the pinned OMP release, then checks the project and effective task settings and the local status ledger's Git exclusion. It does not start a worker, send a prompt, or build the app.

For every feature, name the new behavior and the existing behavior that must remain intact. Add the smallest deterministic check that protects each affected path. The first runnable app change must wire its real Windows build and core journey tests into this workflow. At minimum, test a restored chat opening a real file beside the same chat, link resolution after switching projects, and rejection of a path outside its workspace. Use isolated fixtures and separately confirm native UI behavior in the running Windows app.

After the local check, commit owned changes with OMP's selective commit tool. Push the task branch to the approved `origin`, then open or update one PR targeting `main` with the [review template](.github/pull_request_template.md). The project owner reviews and merges. If `origin/main` does not exist, ask the owner to authorize its initial seed; do not push the task branch first and accidentally set it as the default.

Missing, skipped, or failed required checks are not a pass. Report the exact commands, results, and tested commit. [GitHub check triage](.omp/AGENTS.md#required-skill-routing) verifies the remote run separately from local checks. The workflow does not enforce a GitHub ruleset by itself. Packaging, signing, publishing, and deployment are not configured and require separate approval.

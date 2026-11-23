# OMP Desktop

A Windows-first workspace for local folders, standalone chat, project chat, and an embedded browser. OMP is the runtime, not another feature to rebuild. See the [design mind map](docs/design.md) for scope and decision order. Accepted desktop host: **Electron (`WebContentsView` + isolated session partitions)** with default OMP `--approval-mode always-ask` and default-blocked external network on local interactive HTML previews.

## Core interaction: open files from chat

Match the Antigravity interaction: clicking a filename chip or file link in chat opens the real file in a tab in the right-hand pane. Keep chat and its composer visible. Use one tab strip for file previews and browser tabs; a second click on an already open file focuses its tab. Show the file's path as breadcrumbs, with the parent folder available for browsing nearby files.

- PDF renders in the pane with page navigation and zoom. Code and text open in a source viewer. HTML opens as a running page in an isolated browser tab, not as source text. A folder link opens that location in the file explorer.
- Resolve a link against the workspace that owns its message, not whichever project is currently selected. Standalone chats can open explicitly attached files, not arbitrary local paths. Show a clear error for missing files or links outside the allowed scope. Previewing a file does not attach or send it to a provider.
- A Windows acceptance check must click real links in a restored chat and observe the PDF, source, and interactive HTML beside the same chat. Verify that a stale link and an out-of-workspace link do not open a different file.

## Start working

- Read [project rules](.omp/AGENTS.md) and the primary checkout's existing local `.omp/STATUS.md`, if present (see [`.omp/STATUS.md.example`](.omp/STATUS.md.example) for the ownership-only schema). That ledger records ownership only, not feature progress; never commit or copy it.
- Assign one owner per task with this contract: `Goal | base SHA | branch and absolute worktree | literal write paths | read-only dependencies | primary skill | expected and preserved behavior | exact check`. Follow the [required skill routes](.omp/AGENTS.md#required-skill-routing). New paths need an updated claim before editing.
- The integrator owns shared interfaces, root build files, and integration. Keep dependent tasks queued until their required contract lands on an agreed base.

From the primary checkout, put each linked worktree under the repository's ignored `.worktrees\` directory. Use an unused path, an explicit agreed base SHA, and a unique task branch, then launch `omp` from the worktree root (not a subdirectory, because OMP only reads `<cwd>/.omp/config.yml`):

```powershell
$baseSha = git rev-parse --verify main
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the agreed base SHA.' }
git check-ignore -- .worktrees/omp-rpc/
if ($LASTEXITCODE -ne 0) { throw 'The worktree path must be ignored.' }
if (Test-Path -LiteralPath .worktrees/omp-rpc) { throw 'The worktree path already exists.' }
git worktree add -b work/omp-rpc .worktrees/omp-rpc $baseSha
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

## Decision records and shared contracts

Accepted decisions and frozen shared contracts governing the Electron MVP:

| Slice | Decision record | Shared contract / artifacts |
| --- | --- | --- |
| OMP runtime | [`docs/decisions/omp-runtime.md`](docs/decisions/omp-runtime.md) | [`docs/contracts/omp-adapter.md`](docs/contracts/omp-adapter.md), [`scripts/probe-omp-rpc.ps1`](scripts/probe-omp-rpc.ps1) |
| Desktop and browser host | [`docs/decisions/browser-host.md`](docs/decisions/browser-host.md) | [`docs/contracts/file-reference-and-preview.md`](docs/contracts/file-reference-and-preview.md) |
| Folder and chat workflow | [`docs/decisions/workspace-ux.md`](docs/decisions/workspace-ux.md) | [`docs/contracts/file-reference-and-preview.md`](docs/contracts/file-reference-and-preview.md), [`tests/fixtures/`](tests/fixtures/README.md) |

The first integrated path opens a folder and displays files from its chat in the right-hand pane. Switching to standalone chat preserves each chat's own context. Both use the same OMP adapter.

## Verification and delivery

Run the same harness, RPC probe, build, unit, and Electron acceptance checks as CI from PowerShell with `omp`, Node.js 22, and Git on `PATH`:

```powershell
.\scripts\check-harness.ps1
.\scripts\probe-omp-rpc.ps1
npm ci
npm run typecheck
npm run build
npm test
npm run test:e2e
```

To launch the desktop app locally on Windows:

```powershell
npm start
```

The [Verify workflow](.github/workflows/verify.yml) runs on Windows (`windows-2022`) for PRs targeting `main` and pushes to `main`. It verifies the SHA-256 of the pinned OMP release, checks project/effective OMP task and worktree settings, checks `.gitignore` and tracked-file cleanliness, runs the zero-cost OMP RPC protocol probe (`--mode rpc` and `--mode rpc-ui`), and runs the Windows Electron typecheck, build, unit tests, and Playwright E2E acceptance suite (`ACC-01`–`ACC-08`) against isolated fixtures in [`tests/fixtures/`](tests/fixtures/README.md). It does not send any paid LLM prompts.

For every feature, name the new behavior and the existing behavior that must remain intact. Add the smallest deterministic check that protects each affected path, and separately confirm native UI behavior in the running Windows app.

After the local check, commit owned changes with OMP's selective commit tool (or scoped `git add <owned-paths> && git commit` when local OMP extensions are unavailable). Push the task branch to the approved `origin`, then open or update one PR targeting `main` with the [review template](.github/pull_request_template.md). The project owner reviews and merges. If `origin/main` does not exist, ask the owner to authorize its initial seed; do not push the task branch first and accidentally set it as the default.

Missing, skipped, or failed required checks are not a pass. Report the exact commands, results, and tested commit. [GitHub check triage](.omp/AGENTS.md#required-skill-routing) verifies the remote run separately from local checks. The workflow does not enforce a GitHub ruleset by itself. Packaging, signing, publishing, and deployment are not configured and require separate approval.

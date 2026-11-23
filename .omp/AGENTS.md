# OMP Desktop Project Rules

## Product boundary

Build a Windows-first desktop workspace around the installed OMP runtime. OMP owns agent execution, providers, credentials, tools, and session history. The desktop owns folder selection, native file and browser panes, and presentation. Do not scrape TUI output, rebuild the agent loop, or copy OMP auth into the desktop.

Keep standalone chat independent of project folders. A project chat has an explicit workspace, and switching the visible project does not change an active chat's workspace. A working directory is not a sandbox. Embedded pages and document previews must not have access to desktop IPC, shell, or workspace files. Browser profiles belong outside project folders; do not borrow the user's personal browser. Do not let an unattended task grant itself permissions or send data outside the machine.

The first desktop interaction is [opening a file from chat](../README.md#core-interaction-open-files-from-chat). Resolve file links against the workspace recorded with the message. Preview in a tab beside the same chat, without implicitly attaching or uploading the file.

## Agent workflow

1. Start from a named commit. Read the canonical `.omp/STATUS.md` in the primary checkout. Record owner, absolute worktree, branch, base SHA, literal `Write` paths, and `Shared` dependencies before editing. Treat overlapping paths case-insensitively on Windows. Stop for an overlapping or ambiguous claim.
2. Use one sibling Git worktree and branch per implementation task. `git worktree list --porcelain` identifies the primary checkout and linked worktrees. Do not implement in `main`. Explicitly pass these rules, the task contract, and the correct working directory to a delegated subagent; do not assume child context inherits them.
3. The integrator owns shared contracts and root build files. Agents do not change them without a separate handoff. Do not start a dependent assignment from an unpublished contract. Keep changes and their focused check together under one owner.
4. Before handoff, compare committed, staged, unstaged, and untracked paths with the approved scope. Run the task's exact behavior check in its worktree. For desktop UI, include evidence from the running Windows app, not only a build. Report base/head SHAs, changed paths, command and result, and blockers in the canonical status file.
5. Commit only owned changes. A worker report is not acceptance. The integrator verifies the combined result; only the user authorizes integration, new remotes, or publication. Never use automatic apply, force push, or permission bypass to finish a task.

`task` subagents and `ompt` team workers are distinct. A team path reservation coordinates edits; it is not an OS sandbox or a Git worktree. Use the existing OMP approval flow. Do not write custom scripts to submit `/team` commands or approvals. See the root README for dispatch and suggested slices.

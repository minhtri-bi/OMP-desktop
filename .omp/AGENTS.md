# OMP Desktop Project Rules

## Product boundary

Build a Windows-first desktop workspace around the installed OMP runtime. OMP owns agent execution, providers, credentials, tools, and session history. The desktop owns folder selection, native file and browser panes, and presentation. Do not scrape TUI output, rebuild the agent loop, or copy OMP auth into the desktop.

Keep standalone chat independent of project folders. A project chat has an explicit workspace, and switching the visible project does not change an active chat's workspace. A working directory is not a sandbox. Embedded pages and document previews must not have access to desktop IPC, shell, or workspace files. Browser profiles belong outside project folders; do not borrow the user's personal browser. Do not let an unattended task grant itself permissions or send data outside the machine.

The first desktop interaction is [opening a file from chat](../README.md#core-interaction-open-files-from-chat). Resolve file links against the workspace recorded with the message. Preview in a tab beside the same chat, without implicitly attaching or uploading the file.

## Required skill routing

Before work, name the relevant skill in the assignment and read its exact `skill://<name>` entry. Reread the current repository rules in the assigned worktree. Choose one primary skill per stage; use a specialist only for a distinct need.

| Task | Skill to read |
| --- | --- |
| Resolve overlapping routes or an unclear skill choice | `omp-skill-router` |
| Check OMP RPC, desktop framework, or browser API contracts | `documentation-lookup`; `contract-first` when freezing a shared interface |
| Track milestone dependencies or check cross-file impact | `project-roadmap` for progress; `graphify-local` for the code graph |
| Design or review chat, folder, or preview UI | `omp-ui-design-review`; `accessibility` when changing keyboard, focus, or screen-reader behavior |
| Ship a user-visible feature or extend PR regression checks | `omp-feature-regression-gate`; `tdd` when adding a behavior regression test first |
| Diagnose an unclear failure or a failed GitHub check | `omp-repro-debugging` for local reproduction; `omp-ci-gate-verify` for evidence from the exact GitHub run |
| Make a completion claim or hand off a branch | `verification-before-completion`; `omp-git-handoff` for commit scope and integration |

Use an allowed installed alternative if a skill or local OMP extension (`ompt`, `project_roadmap`, `graphify-local`, selective commit) is unavailable; record the substitution and use scoped `git add <owned-paths> && git commit` as the plain-Git fallback. Do not install skills, bypass a held or explicit-only route, or run a skill's bundled scripts without authorization. Report the skills actually used and the decisive check in the handoff. A skill is guidance, not permission or verification evidence.

## Agent workflow

1. Start from a named commit. Check the primary checkout's existing local `.omp/STATUS.md`, if present, and other claims. Record owner, worktree, branch, base SHA, literal `Write` paths, and `Shared` dependencies. Treat Windows paths case-insensitively. Stop for an overlapping or ambiguous claim. The coordinator tracks feature progress with `project_roadmap` in the dedicated worktree, not in a second progress file.
2. Use one branch and one linked checkout under the repository's ignored `.worktrees/` directory per implementation task. Verify the path is ignored and unused before creating it. Always launch `omp` from the worktree root—not a subdirectory—because OMP loads `<cwd>/.omp/config.yml` without walking ancestor directories. Never implement in `main`. Pass the assignment, checkout path, and these rules to any delegated agent. A Git checkout does not restrict OS permissions.
3. The integrator owns shared contracts and root build files. Agents do not change them without a separate handoff. Do not start a dependent assignment from an unpublished contract. Keep changes and their focused check together under one owner.
4. Before handoff, compare committed, staged, unstaged, and untracked paths with the approved scope. Run the task's exact behavior check in its worktree. For desktop UI, include evidence from the running Windows app, not only a build. Report base/head SHAs, changed paths, command and result, and blockers in the handoff/PR (and let the coordinator record milestones and blockers in `project_roadmap`); keep `.omp/STATUS.md` as an ownership-only claim ledger.
5. Commit only verified, owned changes. Push the task branch to the approved origin and open or update one PR against `main` for the project owner. A worker report is not acceptance. Do not push directly to `main`, merge, change repository rules, force-push, or deploy without separate user authorization.

`task` subagents and `ompt` team workers are distinct. A team path reservation coordinates edits; it is not an OS sandbox or a Git worktree. Use the existing OMP approval flow. Do not write custom scripts to submit `/team` commands or approvals. See the root README for dispatch and suggested slices.

# OMP Desktop Design Map

This map describes the intended Windows app, not shipped features. OMP is the only agent runtime. The desktop is the workspace shell; the desktop framework and browser host are still open decisions.

```mermaid
mindmap
  root((OMP Desktop))
    Workspace
      Local folder and file tree
      File search and breadcrumbs
      Editor, Git diff and terminal
    Chat
      Standalone chat with explicit attachments
      Project chat with a fixed workspace
      Files and tool events in the transcript
    Right-hand tab pane
      File link opens a tab beside chat
      PDF with page navigation and zoom
      Code and text source viewer
      Interactive HTML and localhost preview
      Visible browser with its own profile
    OMP runtime boundary
      Adapter for sessions, streams and tools
      OMP-owned auth and provider settings
      Approval and cancellation events
    Isolation
      File references bound to their workspace
      No desktop bridge in web content
      Explicit approval for external effects
    Delivery
      Separate agent worktrees
      Windows PR verification
      Real UI acceptance for core journeys
```

## Decision order

1. Prove the installed OMP protocol and identify what the adapter can expose without duplicating OMP state ([`decisions/omp-runtime.md`](decisions/omp-runtime.md), [`contracts/omp-adapter.md`](contracts/omp-adapter.md)).
2. Pick a Windows host after checking whether it can render PDF and interactive HTML beside chat while isolating web content ([`decisions/browser-host.md`](decisions/browser-host.md)). Do not treat an embedded tab or a working directory as a sandbox.
3. Freeze the file-reference and preview contracts before splitting implementation ([`decisions/workspace-ux.md`](decisions/workspace-ux.md), [`contracts/file-reference-and-preview.md`](contracts/file-reference-and-preview.md)). Chat and the file tree should open the same tab for the same file in the same workspace. Test a restored chat after switching the visible project.
4. Build the [first click-to-preview journey](../README.md#core-interaction-open-files-from-chat) with the app running on Windows. Then expand to Git, terminal, browsing controls and other capabilities.

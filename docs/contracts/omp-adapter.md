# Contract: OMP Runtime Adapter (`omp-adapter`)

- **Status**: Accepted v1.0 (frozen for Slice 4 implementation)
- **Decision basis**: [`docs/decisions/omp-runtime.md`](../decisions/omp-runtime.md)
- **Target OMP version**: `v19.1.1` (`--mode rpc-ui`, Protocol v2)

## Ownership & invariants

- OMP owns agent execution, providers, credentials, tool registry, approval cache, and session history.
- The desktop adapter owns process spawning, UTF-8 JSONL framing + Protocol v2 `rpc_chunk` reassembly, request/response correlation, approval/UI request bridging, and Windows Job Object cleanup.
- The adapter MUST NOT scrape TUI output, duplicate OMP auth/provider keys, or inject `extension_ui_request (method: "form")` HTML into the desktop shell DOM.

## TypeScript interface specification (language-neutral wire shape)

```ts
export type OmpApprovalMode = "always-ask" | "always-ask-cached" | "write" | "yolo";

export type ChatScope =
  | { kind: "project"; workspaceId: string; canonicalWorkspaceRoot: string }
  | { kind: "standalone"; standaloneCwd: string };

export interface OmpProcessConfig {
  ompExecutablePath: string;
  scope: ChatScope;
  /** Default MUST be "always-ask" (or user-opted "always-ask-cached"), never implicit "yolo". */
  approvalMode: OmpApprovalMode;
  /** Optional session directory for durable chat persistence via open_session / --session-dir. */
  sessionDir?: string;
  /** Optional isolated agent dir override for tests; omitted in production so OMP uses user's own config/auth. */
  agentDirOverride?: string;
  /** Must negotiate protocol v2 immediately after ready; hard-fail if v2 is unsupported. */
  requireProtocolV2: true;
  /** Shutdown drain timeout in milliseconds before terminating the Job Object. */
  shutdownTimeoutMs: number;
}

export interface OmpReadyMetadata {
  ompVersion: string;
  negotiatedProtocolVersion: 2;
  maxFrameBytes: number;
  maxReassembledFrameBytes: number;
  supportsBashExcludeFromContext: boolean;
}

export interface OmpSessionSnapshot {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  isSettled: boolean;
  messageCount: number;
  queuedMessageCount: number;
  hasPendingAsyncWork: boolean;
}

export type OmpDialogRequest =
  | {
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeoutMs?: number;
    }
  | {
      id: string;
      method: "select";
      title: string;
      options: string[];
      optionDetails?: Array<{ description?: string }>;
      initialIndex?: number;
      selectionMarker?: "radio" | "checkbox";
      checkedIndices?: number[];
      markableCount?: number;
      timeoutMs?: number;
    }
  | {
      id: string;
      method: "input" | "editor";
      title: string;
      placeholder?: string;
      secret?: boolean;
      timeoutMs?: number;
    }
  | {
      id: string;
      method: "ask";
      questions: Array<{
        id: string;
        question: string;
        header?: string;
        options: Array<{ label: string; description?: string; preview?: string }>;
        multi?: boolean;
        recommended?: number;
      }>;
      timeoutMs?: number;
    }
  | {
      id: string;
      method: "form";
      /** Untrusted HTML form markup from OMP. Must be parsed into declarative controls or cancelled—never innerHTML in shell. */
      rawHtmlForm: string;
      timeoutMs?: number;
    };

export type OmpDialogResponse =
  | { id: string; kind: "confirm"; confirmed: boolean }
  | { id: string; kind: "value"; value: string }
  | { id: string; kind: "ask"; answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> }
  | { id: string; kind: "form"; data: Record<string, string | number | string[]> }
  | { id: string; kind: "cancel"; timedOut?: boolean };

export type OmpAdapterEvent =
  | { type: "ready"; metadata: OmpReadyMetadata }
  | { type: "state"; state: OmpSessionSnapshot }
  | { type: "message_update"; payload: unknown }
  | { type: "message_end"; message: unknown }
  | { type: "prompt_result"; id?: string; agentInvoked: boolean; status: "completed" | "aborted" | "error"; error?: string; sessionSettled: boolean }
  | { type: "session_settled" }
  | { type: "dialog_request"; request: OmpDialogRequest }
  | { type: "dialog_cancel"; targetId: string }
  | { type: "open_url"; url: string; launchUrl?: string; instructions?: string }
  | { type: "notify"; message: string; level?: string }
  | { type: "available_commands_update"; commands: unknown[] }
  | { type: "transport_error"; code: "NO_CONFIGURED_MODEL" | "PARSE_ERROR" | "CHUNK_PROTOCOL_ERROR" | "FRAME_OVERFLOW" | "PROCESS_EXITED"; message: string; recoverable: boolean };

export interface OmpAdapter {
  start(config: OmpProcessConfig): Promise<OmpReadyMetadata>;
  getState(): Promise<OmpSessionSnapshot>;
  openSession(sessionDir: string): Promise<OmpSessionSnapshot>;
  getMessagesPage(cursor?: string, limit?: number): Promise<{
    messages: unknown[];
    nextCursor?: string;
    totalMessages: number;
  }>;
  sendPrompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<{ id: string }>;
  abort(): Promise<void>;
  respondToDialog(response: OmpDialogResponse): Promise<void>;
  onEvent(listener: (event: OmpAdapterEvent) => void): () => void;
  dispose(): Promise<void>;
}
```

## Protocol & lifecycle requirements

1. **Handshake**: Wait for `ready` -> immediately send `negotiate_protocol` (`protocolVersion: 2`) -> fail startup if v2 fails -> enable `set_ask_dialog` (`enabled: true`) if the UI supports native `ask` dialogs.
2. **Protocol v2 chunk validation**: Validate sequential `chunkId`, `index` (`0..count-1`), `count`, `byteLength <= maxReassembledFrameBytes`, reject interleaved chunks, decode strict UTF-8, and parse one JSON object.
3. **Transcript retention**: Keep streamed `message_end` objects in adapter/store state; never assume `agent_end.messages` contains the entire turn history.
4. **Pagination errors**: Surface `session_busy` and `stale_cursor` error codes explicitly so the UI retries cleanly instead of merging mismatched pages.
5. **Unhandled `form` requests**: If the UI does not yet have a safe declarative `<form>` parser/renderer, immediately respond `{ id, kind: "cancel" }` so `ask` calls in plan mode cannot hang indefinitely.
6. **Shutdown & Windows Job Object**:
   - Every spawned `omp.exe` handle MUST be assigned to a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
   - `dispose()` MUST close `stdin`, continue draining `stdout` to EOF until exit or `shutdownTimeoutMs`, and terminate the Job Object if still alive.
7. **Deterministic zero-cost checks**:
   - [`scripts/probe-omp-rpc.ps1`](../../scripts/probe-omp-rpc.ps1) protects the pinned OMP binary handshake, v2 negotiation, idle state, command listing, empty pagination, parse-error recovery, and clean EOF exit in both `--mode rpc` and `--mode rpc-ui`.

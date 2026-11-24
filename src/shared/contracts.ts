export type OmpApprovalMode = "always-ask" | "always-ask-cached" | "write" | "yolo";

export type ChatScope =
  | { kind: "project"; workspaceId: string; canonicalWorkspaceRoot: string }
  | { kind: "standalone"; standaloneCwd: string };

export interface OmpProcessConfig {
  ompExecutablePath: string;
  ompArgsPrefix?: string[];
  scope: ChatScope;
  approvalMode: OmpApprovalMode;
  sessionDir?: string;
  agentDirOverride?: string;
  modelOverride?: string;
  /** Explicit opt-in when the UI implements a safe declarative form renderer; defaults to false (auto-cancel forms). */
  supportsFormDialog?: boolean;
  /** Explicit opt-in to enable structured ask dialogs via set_ask_dialog after protocol v2 negotiation. */
  supportsAskDialog?: boolean;
  requireProtocolV2: true;
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
      rawHtmlForm: string;
      timeoutMs?: number;
    };

export type OmpDialogResponse =
  | { id: string; kind: "confirm"; confirmed: boolean }
  | { id: string; kind: "value"; value: string }
  | {
      id: string;
      kind: "ask";
      answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }>;
    }
  | { id: string; kind: "form"; data: Record<string, string | number | string[]> }
  | { id: string; kind: "cancel"; timedOut?: boolean };

export type OmpAdapterEvent =
  | { type: "ready"; metadata: OmpReadyMetadata }
  | { type: "state"; state: OmpSessionSnapshot }
  | { type: "message_update"; payload: unknown }
  | { type: "message_end"; message: unknown }
  | {
      type: "prompt_result";
      id?: string;
      agentInvoked: boolean;
      status: "completed" | "aborted" | "error";
      error?: string;
      sessionSettled: boolean;
    }
  | { type: "session_settled" }
  | { type: "dialog_request"; request: OmpDialogRequest }
  | { type: "dialog_cancel"; targetId: string }
  | { type: "open_url"; url: string; launchUrl?: string; instructions?: string }
  | { type: "notify"; message: string; level?: string }
  | { type: "available_commands_update"; commands: unknown[] }
  | {
      type: "transport_error";
      code:
        | "NO_CONFIGURED_MODEL"
        | "PARSE_ERROR"
        | "CHUNK_PROTOCOL_ERROR"
        | "FRAME_OVERFLOW"
        | "PROCESS_EXITED";
      message: string;
      recoverable: boolean;
    };

export type ChatWorkspaceBinding =
  | {
      kind: "project";
      workspaceId: string;
      workspaceRoot: string;
      workspaceDisplayName: string;
    }
  | {
      kind: "standalone";
      chatId: string;
      attachedCanonicalPaths: string[];
    };

export interface LineAnchor {
  startLine: number;
  endLine?: number;
}

export interface MessageFileLinkRequest {
  chatId: string;
  messageId: string;
  isRestoredMessage: boolean;
  owningBinding: ChatWorkspaceBinding;
  rawTarget: string;
  anchor?: LineAnchor;
  preferSourceView?: boolean;
}

export type PathResolutionErrorCode =
  | "UNSAFE_PATH_SYNTAX"
  | "WORKSPACE_UNAVAILABLE"
  | "MISSING_FILE"
  | "STALE_LINK"
  | "OUT_OF_WORKSPACE"
  | "UNATTACHED_STANDALONE_PATH";

export type PreviewViewerKind =
  | "pdf"
  | "source"
  | "html-isolated-browser"
  | "folder-explorer";

export interface BreadcrumbSegment {
  label: string;
  browsableRelativePath: string | null;
}

export interface ResolvedPreviewDescriptor {
  tabKey: string;
  viewerKind: PreviewViewerKind;
  canonicalPath: string;
  displayPath: string;
  breadcrumbs: BreadcrumbSegment[];
  parentBrowsingAllowed: boolean;
  anchor?: LineAnchor;
  isolatedPreviewUrl?: string;
  workspaceToken?: string;
}

export type PathResolutionResult =
  | { ok: true; descriptor: ResolvedPreviewDescriptor }
  | { ok: false; code: PathResolutionErrorCode; message: string; displayTarget: string };

export interface SourceFileContent {
  canonicalPath: string;
  displayPath: string;
  language: string;
  content: string;
  lineCount: number;
  truncated: boolean;
}

export interface FolderEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
}

export interface WorkspaceDescriptor {
  workspaceId: string;
  workspaceRoot: string;
  displayName: string;
}

export interface ChatLinkItem {
  id: string;
  label: string;
  rawTarget: string;
  anchor?: LineAnchor;
  kind?: "file" | "external-url";
}

export interface ChatMessage {
  messageId: string;
  role: "user" | "assistant" | "system";
  text: string;
  isRestoredMessage: boolean;
  links?: ChatLinkItem[];
}

export interface ChatThread {
  chatId: string;
  title: string;
  owningBinding: ChatWorkspaceBinding;
  messages: ChatMessage[];
  composerDraft: string;
}

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RuntimeDiagnostics {
  ompStatus: "idle" | "ready" | "no-configured-model" | "error";
  ompVersion: string | null;
  approvalMode: OmpApprovalMode;
  promptRequestCount: number;
  attachmentUploadCount: number;
  lastError: string | null;
}

export interface BootstrapPayload {
  workspaces: WorkspaceDescriptor[];
  activeWorkspaceId: string | null;
  chats: ChatThread[];
  activeChatId: string;
  diagnostics: RuntimeDiagnostics;
}

export interface OpenFolderResult {
  workspace: WorkspaceDescriptor;
  chat: ChatThread;
}

export interface DesktopBridgeApi {
  getBootstrap(): Promise<BootstrapPayload>;
  openFolderDialog(): Promise<OpenFolderResult | null>;
  createProjectChat(workspaceId: string): Promise<ChatThread | null>;
  listDirectory(workspaceRoot: string, relativeDir: string): Promise<FolderEntry[]>;
  resolveAndOpenLink(request: MessageFileLinkRequest): Promise<PathResolutionResult>;
  readSourceFile(canonicalPath: string, owningBinding: ChatWorkspaceBinding): Promise<SourceFileContent>;
  readPdfBytes(canonicalPath: string, owningBinding: ChatWorkspaceBinding): Promise<Uint8Array>;
  openIsolatedView(params: {
    tabKey: string;
    kind: "html-preview" | "browser";
    url: string;
    workspaceToken?: string;
    allowExternalNetwork: boolean;
    bounds: PreviewBounds;
  }): Promise<{ ok: true; url: string; allowExternalNetwork: boolean } | { ok: false; error: string }>;
  setIsolatedViewBounds(tabKey: string, bounds: PreviewBounds): Promise<void>;
  setIsolatedViewNetworkPolicy(tabKey: string, allowExternalNetwork: boolean): Promise<{ ok: boolean; allowExternalNetwork: boolean }>;
  navigateBrowserView(tabKey: string, url: string): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  hideIsolatedViews(): Promise<void>;
  closeIsolatedView(tabKey: string): Promise<void>;
  attachStandaloneFileDialog(chatId: string): Promise<string | null>;
  getDiagnostics(): Promise<RuntimeDiagnostics>;
  sendPrompt(chatId: string, text: string): Promise<{ ok: boolean; error?: string }>;
  abortTurn(chatId: string): Promise<void>;
  respondToDialog(chatId: string, response: OmpDialogResponse): Promise<{ ok: boolean; error?: string }>;
  syncUiState(update: {
    activeWorkspaceId?: string | null;
    activeChatId?: string;
    draftUpdate?: { chatId: string; draft: string };
  }): Promise<void>;
  onOmpEvent(listener: (event: { chatId: string; event: OmpAdapterEvent }) => void): () => void;
}

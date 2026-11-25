import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type {
  BootstrapPayload,
  ChatLinkItem,
  ChatMessage,
  ChatThread,
  ChatWorkspaceBinding,
  FolderEntry,
  MessageFileLinkRequest,
  OmpDialogResponse,
  PathResolutionResult,
  PreviewBounds,
  RuntimeDiagnostics,
  SourceFileContent,
  WorkspaceDescriptor,
} from "../shared/contracts";
import { parseReplyLinks } from "../shared/link-parser";
import { extractAssistantText, extractStreamingUpdateText } from "../shared/omp-message";
import { OmpRuntimeAdapter } from "./omp-adapter";
import {
  authorizeCanonicalReadPath,
  canonicalizeExistingPath,
  deriveWorkspaceDisplayName,
  normalizeForComparison,
  resolveMessageFileLink,
} from "./path-resolver";
import { IsolatedPreviewManager, registerPreviewProtocolScheme } from "./preview-manager";
import {
  allocateWorkspaceId,
  DesktopStateStore,
  findMatchingProjectChat,
} from "./state-store";

// Must be called synchronously BEFORE app.whenReady()
registerPreviewProtocolScheme();

// Configure isolated userData path BEFORE acquiring the single-instance lock so distinct test
// profiles do not block each other while two launches sharing one profile enforce a single writer.
if (process.env.OMP_DESKTOP_USER_DATA) {
  const customUserData = path.resolve(process.env.OMP_DESKTOP_USER_DATA);
  fs.mkdirSync(customUserData, { recursive: true });
  app.setPath("userData", customUserData);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;

let mainWindow: BrowserWindow | null = null;
let previewManager: IsolatedPreviewManager | null = null;
let stateStore: DesktopStateStore | null = null;
const adaptersByChatId = new Map<string, OmpRuntimeAdapter>();
const startingAdaptersByChatId = new Map<string, Promise<OmpRuntimeAdapter>>();
const startingAdapterInstancesByChatId = new Map<string, OmpRuntimeAdapter>();

const workspaces = new Map<string, WorkspaceDescriptor>();
const chats = new Map<string, ChatThread>();
let activeWorkspaceId: string | null = null;
let activeChatId = "chat-standalone-default";

const diagnostics: RuntimeDiagnostics = {
  ompStatus: "idle",
  ompVersion: null,
  approvalMode: "always-ask",
  promptRequestCount: 0,
  attachmentUploadCount: 0,
  lastError: null,
};

function persistState(): void {
  if (!stateStore) {
    return;
  }
  try {
    stateStore.save({
      workspaces: Array.from(workspaces.values()),
      activeWorkspaceId,
      chats: Array.from(chats.values()),
      activeChatId,
    });
  } catch (err) {
    diagnostics.lastError = err instanceof Error ? err.message : String(err);
  }
}

function appendAndPersistChatMessage(chatId: string, message: ChatMessage): ChatMessage | null {
  const targetChat = chats.get(chatId);
  if (!targetChat) {
    return null;
  }
  targetChat.messages.push(message);
  persistState();
  return message;
}

function broadcastChatMessage(chatId: string, message: ChatMessage): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("omp-desktop:chat-message", { chatId, message });
  }
}

function sessionDirForChat(chatId: string): string {
  const sanitized = chatId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key =
    sanitized === chatId
      ? sanitized
      : `${sanitized}-${crypto.createHash("sha256").update(chatId).digest("hex").slice(0, 8)}`;
  return path.join(app.getPath("userData"), "omp-sessions", key);
}

function languageForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".mjs": "javascript",
    ".json": "json",
    ".md": "markdown",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".ps1": "powershell",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".py": "python",
    ".rs": "rust",
    ".txt": "plaintext",
  };
  return map[ext] ?? "plaintext";
}

function addWorkspace(rootPath: string, explicitId?: string, explicitName?: string): WorkspaceDescriptor {
  const canonicalRoot = canonicalizeExistingPath(rootPath);
  for (const existing of workspaces.values()) {
    if (normalizeForComparison(existing.workspaceRoot) === normalizeForComparison(canonicalRoot)) {
      return existing;
    }
  }
  const workspaceId = allocateWorkspaceId(workspaces.values(), chats.values(), explicitId);
  const displayName =
    explicitName && explicitName.trim()
      ? explicitName
      : deriveWorkspaceDisplayName(canonicalRoot);
  const descriptor: WorkspaceDescriptor = {
    workspaceId,
    workspaceRoot: canonicalRoot,
    displayName,
  };
  workspaces.set(workspaceId, descriptor);
  return descriptor;
}

function initializeFixtureOrDefaultState(): void {
  const persisted = stateStore?.load();
  if (persisted) {
    workspaces.clear();
    for (const ws of persisted.workspaces) {
      workspaces.set(ws.workspaceId, ws);
    }
    chats.clear();
    for (const chat of persisted.chats) {
      chats.set(chat.chatId, chat);
    }
    activeWorkspaceId = persisted.activeWorkspaceId;
    activeChatId = persisted.activeChatId;
    return;
  }

  const fixtureRootEnv = process.env.OMP_DESKTOP_FIXTURE_ROOT;
  const repoRoot = path.resolve(__dirname, "..", "..");
  const candidateFixturesDir = fixtureRootEnv
    ? path.resolve(fixtureRootEnv)
    : path.join(repoRoot, "tests", "fixtures");

  const wsADir = path.join(candidateFixturesDir, "workspace-a");
  const wsBDir = path.join(candidateFixturesDir, "workspace-b");
  const restoredJsonPath = path.join(candidateFixturesDir, "restored-chat.sample.json");

  if (fs.existsSync(wsADir) && fs.existsSync(restoredJsonPath)) {
    const wsA = addWorkspace(wsADir, "ws-fixture-a", "workspace-a");
    if (fs.existsSync(wsBDir)) {
      addWorkspace(wsBDir, "ws-fixture-b", "workspace-b");
    }
    activeWorkspaceId = wsA.workspaceId;

    const raw = JSON.parse(fs.readFileSync(restoredJsonPath, "utf8")) as {
      chatId: string;
      messages: Array<{
        messageId: string;
        role: "user" | "assistant" | "system";
        isRestoredMessage: boolean;
        links: ChatLinkItem[];
      }>;
    };

    const extraLinks: ChatLinkItem[] = [];
    const symlinkTarget = process.env.OMP_DESKTOP_TEST_SYMLINK_LINK;
    if (symlinkTarget) {
      extraLinks.push({
        id: "link-symlink-escape",
        label: "escaped-link.txt",
        rawTarget: symlinkTarget,
      });
    }
    extraLinks.push(
      { id: "link-ads", label: "hello.ts:hidden", rawTarget: "src/hello.ts:hidden" },
      { id: "link-reserved-dos", label: "CON", rawTarget: "CON" },
    );

    const restoredMessages = raw.messages.map((m) => ({
      messageId: m.messageId,
      role: m.role,
      isRestoredMessage: m.isRestoredMessage,
      text: "Restored Workspace A analysis with clickable file chips and preview links:",
      links: [...m.links, ...extraLinks],
    }));

    const projectChat: ChatThread = {
      chatId: raw.chatId,
      title: "Restored Workspace A Chat",
      owningBinding: {
        kind: "project",
        workspaceId: wsA.workspaceId,
        workspaceRoot: wsA.workspaceRoot,
        workspaceDisplayName: wsA.displayName,
      },
      messages: restoredMessages,
      composerDraft: "",
    };
    chats.set(projectChat.chatId, projectChat);
    activeChatId = projectChat.chatId;

    // Standalone chat with one explicitly attached file + one unattached local link to test ACC-05
    const attachedFile = canonicalizeExistingPath(path.join(wsA.workspaceRoot, "src", "hello.ts"));
    const unattachedFile = fs.existsSync(path.join(wsBDir, "notes.md"))
      ? canonicalizeExistingPath(path.join(wsBDir, "notes.md"))
      : path.join(candidateFixturesDir, "outside-workspace", "secret.txt");

    const standaloneChat: ChatThread = {
      chatId: "chat-standalone-default",
      title: "Standalone Chat",
      owningBinding: {
        kind: "standalone",
        chatId: "chat-standalone-default",
        attachedCanonicalPaths: [attachedFile],
      },
      messages: [
        {
          messageId: "standalone-msg-001",
          role: "assistant",
          isRestoredMessage: false,
          text: "Standalone chat is independent of project folders. Only explicitly attached files may open:",
          links: [
            {
              id: "standalone-attached-link",
              label: "hello.ts (attached)",
              rawTarget: attachedFile,
            },
            {
              id: "standalone-unattached-link",
              label: "notes.md (unattached)",
              rawTarget: unattachedFile,
            },
          ],
        },
      ],
      composerDraft: "",
    };
    chats.set(standaloneChat.chatId, standaloneChat);
    return;
  }

  // Fallback clean startup with an empty standalone chat
  const standalone: ChatThread = {
    chatId: "chat-standalone-default",
    title: "Standalone Chat",
    owningBinding: {
      kind: "standalone",
      chatId: "chat-standalone-default",
      attachedCanonicalPaths: [],
    },
    messages: [
      {
        messageId: "welcome-001",
        role: "system",
        isRestoredMessage: false,
        text: "Open a local folder to start a project chat, or attach explicit files in standalone chat.",
      },
    ],
    composerDraft: "",
  };
  chats.set(standalone.chatId, standalone);
  activeChatId = standalone.chatId;
}

function authorizeFileAccess(canonicalPath: string, owningBinding: ChatWorkspaceBinding): string {
  return authorizeCanonicalReadPath(canonicalPath, owningBinding);
}

function getOrCreateProjectChat(ws: WorkspaceDescriptor, forceNew = false): ChatThread {
  if (!forceNew) {
    const existing = findMatchingProjectChat(chats.values(), ws);
    if (existing) {
      return existing;
    }
  }
  let seq = chats.size + 1;
  let chatId = `chat-${ws.workspaceId}-${seq}`;
  while (chats.has(chatId)) {
    seq += 1;
    chatId = `chat-${ws.workspaceId}-${seq}`;
  }
  const chat: ChatThread = {
    chatId,
    title: `${ws.displayName} Chat`,
    owningBinding: {
      kind: "project",
      workspaceId: ws.workspaceId,
      workspaceRoot: ws.workspaceRoot,
      workspaceDisplayName: ws.displayName,
    },
    messages: [
      {
        messageId: `${chatId}-welcome`,
        role: "system",
        isRestoredMessage: false,
        text: `Project chat bound to ${ws.displayName}. Switching projects in the sidebar will not change this chat's workspace.`,
      },
    ],
    composerDraft: "",
  };
  chats.set(chatId, chat);
  return chat;
}

function registerIpcHandlers(): void {
  ipcMain.handle("omp-desktop:get-bootstrap", (): BootstrapPayload => ({
    workspaces: Array.from(workspaces.values()),
    activeWorkspaceId,
    chats: Array.from(chats.values()),
    activeChatId,
    diagnostics: { ...diagnostics },
  }));

  ipcMain.handle(
    "omp-desktop:open-folder-dialog",
    async (): Promise<{ workspace: WorkspaceDescriptor; chat: ChatThread } | null> => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"],
        title: "Open Workspace Folder",
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      const ws = addWorkspace(result.filePaths[0]!);
      const chat = getOrCreateProjectChat(ws, false);
      activeWorkspaceId = ws.workspaceId;
      activeChatId = chat.chatId;
      persistState();
      return { workspace: ws, chat };
    },
  );

  ipcMain.handle(
    "omp-desktop:create-project-chat",
    (_event, workspaceId: string): ChatThread | null => {
      const ws = workspaces.get(workspaceId);
      if (!ws) return null;
      const chat = getOrCreateProjectChat(ws, true);
      activeChatId = chat.chatId;
      persistState();
      return chat;
    },
  );

  ipcMain.handle(
    "omp-desktop:list-directory",
    (_event, workspaceRoot: string, relativeDir: string): FolderEntry[] => {
      const realRoot = canonicalizeExistingPath(workspaceRoot);
      const resolved = relativeDir
        ? resolveMessageFileLink({
            chatId: "explorer",
            messageId: "explorer",
            isRestoredMessage: false,
            owningBinding: {
              kind: "project",
              workspaceId: "explorer",
              workspaceRoot: realRoot,
              workspaceDisplayName: deriveWorkspaceDisplayName(realRoot),
            },
            rawTarget: relativeDir,
          })
        : null;
      if (resolved && (!resolved.ok || resolved.descriptor.viewerKind !== "folder-explorer")) {
        return [];
      }
      const realTarget = resolved && resolved.ok ? resolved.descriptor.canonicalPath : realRoot;
      const entries = fs.readdirSync(realTarget, { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith(".git"))
        .map((e) => ({
          name: e.name,
          relativePath: path
            .relative(realRoot, path.join(realTarget, e.name))
            .replace(/\\/g, "/"),
          isDirectory: e.isDirectory(),
        }))
        .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
    },
  );

  ipcMain.handle(
    "omp-desktop:resolve-link",
    (_event, request: MessageFileLinkRequest): PathResolutionResult => {
      // Strictly resolve against the owningBinding stored on the chat/message.
      // Previewing never triggers any OMP prompt or implicit attachment.
      const resolved = resolveMessageFileLink(request);
      if (!resolved.ok) {
        return resolved;
      }

      if (resolved.descriptor.viewerKind === "html-isolated-browser" && previewManager) {
        if (request.owningBinding.kind === "project") {
          const { token, previewUrl } = previewManager.buildWorkspacePreviewUrl(
            request.owningBinding.workspaceRoot,
            resolved.descriptor.canonicalPath,
          );
          resolved.descriptor.isolatedPreviewUrl = previewUrl;
          resolved.descriptor.workspaceToken = token;
        } else {
          const { token, previewUrl } = previewManager.registerStandaloneFileScope(
            resolved.descriptor.canonicalPath,
          );
          resolved.descriptor.isolatedPreviewUrl = previewUrl;
          resolved.descriptor.workspaceToken = token;
        }
      }
      return resolved;
    },
  );

  ipcMain.handle(
    "omp-desktop:read-source",
    (_event, canonicalPath: string, owningBinding: ChatWorkspaceBinding): SourceFileContent => {
      const safePath = authorizeFileAccess(canonicalPath, owningBinding);
      const stat = fs.statSync(safePath);
      const truncated = stat.size > MAX_SOURCE_BYTES;
      const fd = fs.openSync(safePath, "r");
      try {
        const len = Math.min(stat.size, MAX_SOURCE_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, 0);
        const content = buf.toString("utf8");
        const displayPath =
          owningBinding.kind === "project"
            ? path.relative(canonicalizeExistingPath(owningBinding.workspaceRoot), safePath).replace(/\\/g, "/")
            : path.basename(safePath);
        return {
          canonicalPath: safePath,
          displayPath,
          language: languageForPath(safePath),
          content,
          lineCount: content.split(/\r?\n/).length,
          truncated,
        };
      } finally {
        fs.closeSync(fd);
      }
    },
  );

  ipcMain.handle(
    "omp-desktop:read-pdf-bytes",
    (_event, canonicalPath: string, owningBinding: ChatWorkspaceBinding): Uint8Array => {
      const safePath = authorizeFileAccess(canonicalPath, owningBinding);
      const stat = fs.statSync(safePath);
      if (stat.size > MAX_PDF_BYTES) {
        throw new Error("PDF exceeds maximum preview size limit.");
      }
      return new Uint8Array(fs.readFileSync(safePath));
    },
  );

  ipcMain.handle(
    "omp-desktop:open-isolated-view",
    async (
      _event,
      params: {
        tabKey: string;
        kind: "html-preview" | "browser";
        url: string;
        workspaceToken?: string;
        allowExternalNetwork: boolean;
        bounds: PreviewBounds;
      },
    ) => {
      if (!previewManager) {
        return { ok: false as const, error: "Preview manager is not initialized." };
      }
      return previewManager.openOrFocusView(params);
    },
  );

  ipcMain.handle(
    "omp-desktop:set-isolated-view-bounds",
    (_event, tabKey: string, bounds: PreviewBounds) => {
      previewManager?.setBounds(tabKey, bounds);
    },
  );

  ipcMain.handle(
    "omp-desktop:set-isolated-view-network",
    async (_event, tabKey: string, allowExternalNetwork: boolean) => {
      if (!previewManager) {
        return { ok: false, allowExternalNetwork: false };
      }
      return previewManager.setExternalNetworkPolicy(tabKey, allowExternalNetwork);
    },
  );

  ipcMain.handle("omp-desktop:navigate-browser-view", async (_event, tabKey: string, url: string) => {
    if (!previewManager) {
      return { ok: false as const, error: "Preview manager is not initialized." };
    }
    return previewManager.navigateBrowser(tabKey, url);
  });

  ipcMain.handle("omp-desktop:hide-isolated-views", () => {
    previewManager?.hideAll();
  });

  ipcMain.handle("omp-desktop:close-isolated-view", (_event, tabKey: string) => {
    previewManager?.closeView(tabKey);
  });

  ipcMain.handle(
    "omp-desktop:attach-standalone-file",
    async (_event, chatId: string): Promise<string | null> => {
      if (!mainWindow) return null;
      const chat = chats.get(chatId);
      if (!chat || chat.owningBinding.kind !== "standalone") return null;
      const picked = await dialog.showOpenDialog(mainWindow, {
        properties: ["openFile"],
        title: "Attach File to Standalone Chat",
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        return null;
      }
      const canonical = canonicalizeExistingPath(picked.filePaths[0]!);
      if (
        !chat.owningBinding.attachedCanonicalPaths.some(
          (p) => normalizeForComparison(p) === normalizeForComparison(canonical),
        )
      ) {
        chat.owningBinding.attachedCanonicalPaths.push(canonical);
        persistState();
      }
      return canonical;
    },
  );

  ipcMain.handle("omp-desktop:get-diagnostics", (): RuntimeDiagnostics => {
    let totalPrompts = diagnostics.promptRequestCount;
    for (const adapter of adaptersByChatId.values()) {
      totalPrompts += adapter.getPromptRequestCount();
    }
    return {
      ...diagnostics,
      promptRequestCount: totalPrompts,
    };
  });

  ipcMain.handle("omp-desktop:send-prompt", async (_event, chatId: string, text: string) => {
    const chat = chats.get(chatId);
    if (!chat) {
      return { ok: false, error: "Unknown chat thread." };
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, error: "Prompt text cannot be empty." };
    }

    // Main process is the single source of truth for transcript messages and persistence.
    chat.composerDraft = "";
    const userMessage: ChatMessage = {
      messageId: `user-${Date.now()}-${chat.messages.length}`,
      role: "user",
      text: trimmed,
      isRestoredMessage: false,
    };
    appendAndPersistChatMessage(chatId, userMessage);
    broadcastChatMessage(chatId, userMessage);

    const ensureRunningAdapter = async (): Promise<OmpRuntimeAdapter> => {
      const existing = adaptersByChatId.get(chatId);
      if (existing && existing.isRunning()) {
        return existing;
      }
      if (existing) {
        diagnostics.promptRequestCount += existing.getPromptRequestCount();
        adaptersByChatId.delete(chatId);
        await existing.dispose();
      }

      const inflight = startingAdaptersByChatId.get(chatId);
      if (inflight) {
        return inflight;
      }

      const startPromise = (async () => {
        if (chat.owningBinding.kind === "project") {
          const rootCandidate = chat.owningBinding.workspaceRoot;
          if (rootCandidate.startsWith("\\\\") || rootCandidate.startsWith("//")) {
            throw new Error("Owning workspace uses an unsupported UNC or device path.");
          }
          let rootLs: fs.Stats;
          try {
            rootLs = fs.lstatSync(rootCandidate);
          } catch {
            throw new Error(
              `Owning workspace "${chat.owningBinding.workspaceDisplayName}" is no longer available on disk.`,
            );
          }
          if (rootLs.isSymbolicLink() || !rootLs.isDirectory()) {
            throw new Error(
              `Owning workspace "${chat.owningBinding.workspaceDisplayName}" is not a valid local directory.`,
            );
          }
        }

        const ompBin = process.env.OMP_DESKTOP_OMP_PATH || "omp";
        let ompArgsPrefix: string[] | undefined;
        if (process.env.OMP_DESKTOP_OMP_ARGS_PREFIX) {
          try {
            const parsed = JSON.parse(process.env.OMP_DESKTOP_OMP_ARGS_PREFIX) as unknown;
            if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
              ompArgsPrefix = parsed;
            }
          } catch {
            // ignore malformed optional test override
          }
        }

        const adapter = new OmpRuntimeAdapter();
        // Register the starting instance immediately so extension `session_start` dialogs
        // can receive `extension_ui_response` frames before protocol v2 negotiation completes.
        startingAdapterInstancesByChatId.set(chatId, adapter);

        let adapterPartialText = "";
        adapter.onEvent((ev) => {
          let appendedMessage: ChatMessage | null = null;
          if (ev.type === "ready") {
            diagnostics.ompStatus = "ready";
            diagnostics.ompVersion = ev.metadata.ompVersion;
          } else if (ev.type === "message_update") {
            const next = extractStreamingUpdateText(ev.payload, adapterPartialText);
            if (next !== null) {
              adapterPartialText = next;
            }
          } else if (ev.type === "message_end") {
            adapterPartialText = "";
            const targetChat = chats.get(chatId);
            const extracted = extractAssistantText(ev.message);
            if (targetChat && extracted) {
              const messageId = `omp-${Date.now()}-${targetChat.messages.length}`;
              const parsedLinks = parseReplyLinks(extracted.text, messageId);
              appendedMessage = appendAndPersistChatMessage(chatId, {
                messageId,
                role: extracted.role,
                text: extracted.text,
                links: parsedLinks.length > 0 ? parsedLinks : undefined,
                isRestoredMessage: false,
              });
            }
          } else if (ev.type === "prompt_result") {
            const trimmedPartial = adapterPartialText.trim();
            adapterPartialText = "";
            if (ev.status === "aborted") {
              const targetChat = chats.get(chatId);
              if (targetChat) {
                if (trimmedPartial.length > 0) {
                  const messageId = `omp-aborted-${Date.now()}-${targetChat.messages.length}`;
                  const parsedLinks = parseReplyLinks(trimmedPartial, messageId);
                  appendedMessage = appendAndPersistChatMessage(chatId, {
                    messageId,
                    role: "assistant",
                    text: `${trimmedPartial}\n\n[Turn aborted]`,
                    links: parsedLinks.length > 0 ? parsedLinks : undefined,
                    isRestoredMessage: false,
                  });
                } else {
                  appendedMessage = appendAndPersistChatMessage(chatId, {
                    messageId: `sys-aborted-${Date.now()}-${targetChat.messages.length}`,
                    role: "system",
                    text: "Turn aborted.",
                    isRestoredMessage: false,
                  });
                }
              }
            }
          } else if (ev.type === "session_settled") {
            adapterPartialText = "";
          } else if (ev.type === "transport_error") {
            if (!ev.recoverable) {
              adapterPartialText = "";
            }
            if (ev.code === "NO_CONFIGURED_MODEL") {
              diagnostics.ompStatus = "no-configured-model";
              diagnostics.lastError = ev.message;
            } else if (!ev.recoverable) {
              diagnostics.ompStatus = "error";
              diagnostics.lastError = ev.message;
            }
            if (!ev.recoverable) {
              if (adaptersByChatId.get(chatId) === adapter) {
                diagnostics.promptRequestCount += adapter.getPromptRequestCount();
                adaptersByChatId.delete(chatId);
              }
              if (startingAdapterInstancesByChatId.get(chatId) === adapter) {
                startingAdapterInstancesByChatId.delete(chatId);
              }
              // Ensure idempotent disposal (including Job Object cleanup) on every fatal eviction.
              void adapter.dispose();
            }
          }
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("omp-desktop:omp-event", { chatId, event: ev });
          }
          if (appendedMessage) {
            broadcastChatMessage(chatId, appendedMessage);
          }
        });

        const standaloneCwd = path.join(app.getPath("userData"), "standalone-cwd");
        const sessionDir = sessionDirForChat(chatId);

        try {
          await adapter.start({
            ompExecutablePath: ompBin,
            ompArgsPrefix,
            scope:
              chat.owningBinding.kind === "project"
                ? {
                    kind: "project",
                    workspaceId: chat.owningBinding.workspaceId,
                    canonicalWorkspaceRoot: canonicalizeExistingPath(chat.owningBinding.workspaceRoot),
                  }
                : {
                    kind: "standalone",
                    standaloneCwd,
                  },
            approvalMode: "always-ask",
            sessionDir,
            resumeSession: true,
            supportsFormDialog: false,
            supportsAskDialog: true,
            requireProtocolV2: true,
            shutdownTimeoutMs: 5_000,
          });
          if (!adapter.isRunning()) {
            throw new Error("OMP runtime exited before startup completed.");
          }
          adaptersByChatId.set(chatId, adapter);
          return adapter;
        } finally {
          if (startingAdapterInstancesByChatId.get(chatId) === adapter) {
            startingAdapterInstancesByChatId.delete(chatId);
          }
        }
      })();

      startingAdaptersByChatId.set(chatId, startPromise);
      try {
        return await startPromise;
      } finally {
        startingAdaptersByChatId.delete(chatId);
      }
    };

    let adapter: OmpRuntimeAdapter;
    try {
      adapter = await ensureRunningAdapter();
    } catch (err) {
      diagnostics.lastError = err instanceof Error ? err.message : String(err);
      return { ok: false, error: diagnostics.lastError };
    }

    try {
      const promptRes = await adapter.sendPrompt(trimmed);
      return { ok: true, agentInvoked: promptRes.agentInvoked };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("omp-desktop:abort-turn", async (_event, chatId: string) => {
    const adapter = adaptersByChatId.get(chatId);
    if (adapter && adapter.isRunning()) {
      await adapter.abort();
    }
  });

  ipcMain.handle(
    "omp-desktop:respond-dialog",
    async (_event, chatId: string, response: OmpDialogResponse) => {
      if (!response || typeof response !== "object" || typeof response.id !== "string" || !response.id) {
        return { ok: false, error: "Invalid dialog response payload." };
      }
      // Permit dialog responses for both running and starting adapters as soon as stdin is writable,
      // so startup `session_start` extension dialogs can unblock protocol negotiation.
      const adapter = adaptersByChatId.get(chatId) ?? startingAdapterInstancesByChatId.get(chatId);
      if (!adapter || !adapter.isTransportWritable()) {
        return { ok: false, error: "OMP runtime is not active for this chat." };
      }
      try {
        await adapter.respondToDialog(response);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    "omp-desktop:sync-ui-state",
    (
      _event,
      update: {
        activeWorkspaceId?: string | null;
        activeChatId?: string;
        draftUpdate?: { chatId: string; draft: string };
      },
    ) => {
      if (!update || typeof update !== "object") {
        return;
      }
      if (update.activeWorkspaceId !== undefined) {
        if (update.activeWorkspaceId === null || workspaces.has(update.activeWorkspaceId)) {
          activeWorkspaceId = update.activeWorkspaceId;
        }
      }
      if (typeof update.activeChatId === "string" && chats.has(update.activeChatId)) {
        activeChatId = update.activeChatId;
      }
      if (
        update.draftUpdate &&
        typeof update.draftUpdate.chatId === "string" &&
        typeof update.draftUpdate.draft === "string"
      ) {
        const target = chats.get(update.draftUpdate.chatId);
        if (target) {
          target.composerDraft = update.draftUpdate.draft;
        }
      }
      persistState();
    },
  );
}

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "OMP Desktop",
    backgroundColor: "#F8F7F4",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  previewManager = new IsolatedPreviewManager({
    hostWindow: mainWindow,
    onRequestNewBrowserTab: (url) => {
      mainWindow?.webContents.send("omp-desktop:open-browser-tab", url);
    },
    onBlockedNavigation: (tabKey, url, reason) => {
      mainWindow?.webContents.send("omp-desktop:blocked-navigation", { tabKey, url, reason });
    },
  });

  // Block untrusted navigation in the desktop shell window itself
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const rendererHtml = path.join(__dirname, "..", "renderer", "index.html");
  await mainWindow.loadFile(rendererHtml);
}

let quitPhase: "idle" | "disposing" | "ready" = "idle";

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    stateStore = new DesktopStateStore(app.getPath("userData"));
    initializeFixtureOrDefaultState();
    registerIpcHandlers();
    await createMainWindow();
  });

  app.on("before-quit", (event) => {
    if (quitPhase === "ready") {
      return;
    }
    event.preventDefault();
    if (quitPhase === "disposing") {
      return;
    }
    quitPhase = "disposing";
    persistState();
    previewManager?.disposeAll();
    const activeAdapters = Array.from(
      new Set<OmpRuntimeAdapter>([
        ...adaptersByChatId.values(),
        ...startingAdapterInstancesByChatId.values(),
      ]),
    );
    adaptersByChatId.clear();
    startingAdapterInstancesByChatId.clear();
    void Promise.allSettled(activeAdapters.map((adapter) => adapter.dispose())).finally(() => {
      quitPhase = "ready";
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}

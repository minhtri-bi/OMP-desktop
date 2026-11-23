import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type {
  BootstrapPayload,
  ChatLinkItem,
  ChatThread,
  ChatWorkspaceBinding,
  FolderEntry,
  MessageFileLinkRequest,
  PathResolutionResult,
  PreviewBounds,
  RuntimeDiagnostics,
  SourceFileContent,
  WorkspaceDescriptor,
} from "../shared/contracts";
import { OmpRuntimeAdapter } from "./omp-adapter";
import {
  canonicalizeExistingPath,
  isPathWithinRoot,
  normalizeForComparison,
  resolveMessageFileLink,
} from "./path-resolver";
import { IsolatedPreviewManager, registerPreviewProtocolScheme } from "./preview-manager";

// Must be called synchronously BEFORE app.whenReady()
registerPreviewProtocolScheme();

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;

let mainWindow: BrowserWindow | null = null;
let previewManager: IsolatedPreviewManager | null = null;
const adaptersByChatId = new Map<string, OmpRuntimeAdapter>();

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
  const workspaceId = explicitId ?? `ws-${workspaces.size + 1}`;
  const displayName = explicitName ?? path.basename(canonicalRoot);
  const descriptor: WorkspaceDescriptor = {
    workspaceId,
    workspaceRoot: canonicalRoot,
    displayName,
  };
  workspaces.set(workspaceId, descriptor);
  return descriptor;
}

function initializeFixtureOrDefaultState(): void {
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
  const realTarget = canonicalizeExistingPath(canonicalPath);
  if (owningBinding.kind === "standalone") {
    const allowed = new Set(
      owningBinding.attachedCanonicalPaths.map((p) => normalizeForComparison(p)),
    );
    if (!allowed.has(normalizeForComparison(realTarget))) {
      throw new Error("Access denied: file is outside standalone chat attachments.");
    }
    return realTarget;
  }
  const realRoot = canonicalizeExistingPath(owningBinding.workspaceRoot);
  if (!isPathWithinRoot(realTarget, realRoot)) {
    throw new Error("Access denied: file escapes owning workspace root.");
  }
  return realTarget;
}

function registerIpcHandlers(): void {
  ipcMain.handle("omp-desktop:get-bootstrap", (): BootstrapPayload => ({
    workspaces: Array.from(workspaces.values()),
    activeWorkspaceId,
    chats: Array.from(chats.values()),
    activeChatId,
    diagnostics: { ...diagnostics },
  }));

  ipcMain.handle("omp-desktop:open-folder-dialog", async (): Promise<WorkspaceDescriptor | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Open Workspace Folder",
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const ws = addWorkspace(result.filePaths[0]!);
    activeWorkspaceId = ws.workspaceId;
    return ws;
  });

  ipcMain.handle(
    "omp-desktop:list-directory",
    (_event, workspaceRoot: string, relativeDir: string): FolderEntry[] => {
      const realRoot = canonicalizeExistingPath(workspaceRoot);
      const target = relativeDir
        ? path.resolve(realRoot, relativeDir.replace(/\\/g, path.sep))
        : realRoot;
      if (!isPathWithinRoot(target, realRoot) || !fs.existsSync(target)) {
        return [];
      }
      const realTarget = canonicalizeExistingPath(target);
      if (!isPathWithinRoot(realTarget, realRoot)) {
        return [];
      }
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
    const ompBin = process.env.OMP_DESKTOP_OMP_PATH || "omp";
    let adapter = adaptersByChatId.get(chatId);
    if (!adapter) {
      adapter = new OmpRuntimeAdapter();
      adapter.onEvent((ev) => {
        if (ev.type === "ready") {
          diagnostics.ompStatus = "ready";
          diagnostics.ompVersion = ev.metadata.ompVersion;
        } else if (ev.type === "transport_error" && ev.code === "NO_CONFIGURED_MODEL") {
          diagnostics.ompStatus = "no-configured-model";
          diagnostics.lastError = ev.message;
        }
        mainWindow?.webContents.send("omp-desktop:omp-event", { chatId, event: ev });
      });
      const standaloneCwd = path.join(app.getPath("userData"), "standalone-cwd");
      try {
        await adapter.start({
          ompExecutablePath: ompBin,
          scope:
            chat.owningBinding.kind === "project"
              ? {
                  kind: "project",
                  workspaceId: chat.owningBinding.workspaceId,
                  canonicalWorkspaceRoot: chat.owningBinding.workspaceRoot,
                }
              : {
                  kind: "standalone",
                  standaloneCwd,
                },
          approvalMode: "always-ask",
          requireProtocolV2: true,
          shutdownTimeoutMs: 5_000,
        });
        adaptersByChatId.set(chatId, adapter);
      } catch (err) {
        diagnostics.lastError = err instanceof Error ? err.message : String(err);
        return { ok: false, error: diagnostics.lastError };
      }
    }

    try {
      await adapter.sendPrompt(text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("omp-desktop:abort-turn", async (_event, chatId: string) => {
    const adapter = adaptersByChatId.get(chatId);
    if (adapter) {
      await adapter.abort();
    }
  });
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

app.whenReady().then(async () => {
  if (process.env.OMP_DESKTOP_USER_DATA) {
    app.setPath("userData", path.resolve(process.env.OMP_DESKTOP_USER_DATA));
  }
  initializeFixtureOrDefaultState();
  registerIpcHandlers();
  await createMainWindow();
});

app.on("before-quit", () => {
  previewManager?.disposeAll();
  for (const adapter of adaptersByChatId.values()) {
    void adapter.dispose();
  }
  adaptersByChatId.clear();
});

app.on("window-all-closed", () => {
  app.quit();
});

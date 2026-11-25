import { contextBridge, ipcRenderer } from "electron";
import type {
  ChatMessage,
  ChatWorkspaceBinding,
  DesktopBridgeApi,
  MessageFileLinkRequest,
  OmpAdapterEvent,
  PreviewBounds,
} from "../shared/contracts";

const bridge: DesktopBridgeApi = {
  getBootstrap: () => ipcRenderer.invoke("omp-desktop:get-bootstrap"),
  openFolderDialog: () => ipcRenderer.invoke("omp-desktop:open-folder-dialog"),
  createProjectChat: (workspaceId: string) =>
    ipcRenderer.invoke("omp-desktop:create-project-chat", workspaceId),
  listDirectory: (workspaceRoot: string, relativeDir: string) =>
    ipcRenderer.invoke("omp-desktop:list-directory", workspaceRoot, relativeDir),
  resolveAndOpenLink: (request: MessageFileLinkRequest) =>
    ipcRenderer.invoke("omp-desktop:resolve-link", request),
  readSourceFile: (canonicalPath: string, owningBinding: ChatWorkspaceBinding) =>
    ipcRenderer.invoke("omp-desktop:read-source", canonicalPath, owningBinding),
  readPdfBytes: (canonicalPath: string, owningBinding: ChatWorkspaceBinding) =>
    ipcRenderer.invoke("omp-desktop:read-pdf-bytes", canonicalPath, owningBinding),
  openIsolatedView: (params) => ipcRenderer.invoke("omp-desktop:open-isolated-view", params),
  setIsolatedViewBounds: (tabKey: string, bounds: PreviewBounds) =>
    ipcRenderer.invoke("omp-desktop:set-isolated-view-bounds", tabKey, bounds),
  setIsolatedViewNetworkPolicy: (tabKey: string, allowExternalNetwork: boolean) =>
    ipcRenderer.invoke("omp-desktop:set-isolated-view-network", tabKey, allowExternalNetwork),
  navigateBrowserView: (tabKey: string, url: string) =>
    ipcRenderer.invoke("omp-desktop:navigate-browser-view", tabKey, url),
  hideIsolatedViews: () => ipcRenderer.invoke("omp-desktop:hide-isolated-views"),
  closeIsolatedView: (tabKey: string) =>
    ipcRenderer.invoke("omp-desktop:close-isolated-view", tabKey),
  attachStandaloneFileDialog: (chatId: string) =>
    ipcRenderer.invoke("omp-desktop:attach-standalone-file", chatId),
  getDiagnostics: () => ipcRenderer.invoke("omp-desktop:get-diagnostics"),
  sendPrompt: (chatId: string, text: string) =>
    ipcRenderer.invoke("omp-desktop:send-prompt", chatId, text),
  abortTurn: (chatId: string) => ipcRenderer.invoke("omp-desktop:abort-turn", chatId),
  respondToDialog: (chatId, response) =>
    ipcRenderer.invoke("omp-desktop:respond-dialog", chatId, response),
  syncUiState: (update) => ipcRenderer.invoke("omp-desktop:sync-ui-state", update),
  onChatMessage: (listener: (payload: { chatId: string; message: ChatMessage }) => void) => {
    const wrapped = (
      _ev: Electron.IpcRendererEvent,
      payload: { chatId: string; message: ChatMessage },
    ) => {
      listener(payload);
    };
    ipcRenderer.on("omp-desktop:chat-message", wrapped);
    return () => {
      ipcRenderer.removeListener("omp-desktop:chat-message", wrapped);
    };
  },
  onOmpEvent: (listener: (event: { chatId: string; event: OmpAdapterEvent }) => void) => {
    const wrapped = (_ev: Electron.IpcRendererEvent, payload: { chatId: string; event: OmpAdapterEvent }) => {
      listener(payload);
    };
    ipcRenderer.on("omp-desktop:omp-event", wrapped);
    return () => {
      ipcRenderer.removeListener("omp-desktop:omp-event", wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("ompDesktop", bridge);

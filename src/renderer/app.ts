import type {
  ChatLinkItem,
  ChatMessage,
  ChatThread,
  ChatWorkspaceBinding,
  DesktopBridgeApi,
  FolderEntry,
  LineAnchor,
  OmpDialogRequest,
  ResolvedPreviewDescriptor,
  SourceFileContent,
  WorkspaceDescriptor,
} from "../shared/contracts";
import { extractStreamingUpdateText } from "../shared/omp-message";
import {
  buildNoConfiguredModelCard,
  buildOmpDialogCard,
  buildOpenUrlCard,
  type OpenUrlPromptItem,
} from "./dialog-cards";
import { PdfPreviewController } from "./pdf-viewer";

declare global {
  interface Window {
    ompDesktop: DesktopBridgeApi;
  }
}

interface OpenTab {
  tabKey: string;
  kind: "pdf" | "source" | "html-isolated-browser" | "browser";
  title: string;
  descriptor?: ResolvedPreviewDescriptor;
  owningBinding?: ChatWorkspaceBinding;
  sourceData?: SourceFileContent;
  pdfBytes?: Uint8Array;
  pdfPage?: number;
  pdfTotalPages?: number;
  pdfZoom?: number;
  browserUrl?: string;
  allowExternalNetwork?: boolean;
}

const api = window.ompDesktop;

let workspaces: WorkspaceDescriptor[] = [];
let activeWorkspaceId: string | null = null;
let chats: ChatThread[] = [];
let activeChatId = "";
let openTabs: OpenTab[] = [];
let activeTabKey: string | null = null;
let browserTabCounter = 0;

const expandedDirsByWorkspace = new Map<string, Set<string>>();
const turnActiveChats = new Set<string>();
const streamingTextByChatId = new Map<string, string>();
const pendingDialogsByChatId = new Map<string, OmpDialogRequest[]>();
const pendingOpenUrlByChatId = new Map<string, OpenUrlPromptItem>();
const unconfiguredModelChatIds = new Set<string>();
const dialogContainerByChatId = new Map<string, HTMLElement>();
let draftSyncTimer: ReturnType<typeof setTimeout> | null = null;

const workspaceListEl = document.getElementById("workspace-list")!;
const chatListEl = document.getElementById("chat-list")!;
const newProjectChatBtn = document.getElementById("new-project-chat-btn") as HTMLButtonElement;
const explorerHeadingEl = document.getElementById("explorer-heading")!;
const fileTreeEl = document.getElementById("file-tree")!;
const activeChatTitleEl = document.getElementById("active-chat-title")!;
const activeChatScopeEl = document.getElementById("active-chat-scope")!;
const attachStandaloneBtn = document.getElementById("attach-standalone-btn")!;
const linkErrorBannerEl = document.getElementById("link-error-banner")!;
const linkErrorCodeEl = document.getElementById("link-error-code")!;
const linkErrorMessageEl = document.getElementById("link-error-message")!;
const dismissErrorBtn = document.getElementById("dismiss-error-btn")!;
const onboardingSlotEl = document.getElementById("onboarding-slot")!;
const chatTranscriptEl = document.getElementById("chat-transcript")!;
const chatDialogsEl = document.getElementById("chat-dialogs")!;
const standaloneAttachmentsEl = document.getElementById("standalone-attachments")!;
const composerForm = document.getElementById("composer-form") as HTMLFormElement;
const composerInput = document.getElementById("composer-input") as HTMLTextAreaElement;
const composerAbortBtn = document.getElementById("composer-abort-btn") as HTMLButtonElement;
const composerSendBtn = document.getElementById("composer-send-btn") as HTMLButtonElement;
const tabStripEl = document.getElementById("tab-strip")!;
const breadcrumbsBarEl = document.getElementById("breadcrumbs-bar")!;
const breadcrumbsNavEl = document.getElementById("breadcrumbs-nav")!;
const breadcrumbSiblingsEl = document.getElementById("breadcrumb-siblings")!;
const previewToolbarEl = document.getElementById("preview-toolbar")!;
const previewEmptyEl = document.getElementById("preview-empty")!;
const sourceViewerEl = document.getElementById("source-viewer")!;
const pdfViewerEl = document.getElementById("pdf-viewer")!;
const pdfCanvasEl = document.getElementById("pdf-canvas") as HTMLCanvasElement;
const isolatedViewHostEl = document.getElementById("isolated-view-host")!;
const openFolderBtn = document.getElementById("open-folder-btn")!;
const newBrowserTabBtn = document.getElementById("new-browser-tab-btn")!;

const pdfController = new PdfPreviewController(pdfCanvasEl);

function getActiveChat(): ChatThread | undefined {
  return chats.find((c) => c.chatId === activeChatId);
}

function getActiveWorkspace(): WorkspaceDescriptor | undefined {
  return workspaces.find((w) => w.workspaceId === activeWorkspaceId);
}

function getActiveTab(): OpenTab | undefined {
  return openTabs.find((t) => t.tabKey === activeTabKey);
}

function showError(code: string, message: string): void {
  linkErrorCodeEl.textContent = code;
  linkErrorMessageEl.textContent = message;
  linkErrorBannerEl.classList.remove("hidden");
}

function clearError(): void {
  linkErrorBannerEl.classList.add("hidden");
  linkErrorCodeEl.textContent = "";
  linkErrorMessageEl.textContent = "";
}

function hideSiblingPopover(): void {
  breadcrumbSiblingsEl.classList.add("hidden");
  breadcrumbSiblingsEl.innerHTML = "";
}

function getIsolatedHostBounds(): { x: number; y: number; width: number; height: number } {
  const rect = isolatedViewHostEl.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

async function syncActiveIsolatedViewBounds(): Promise<void> {
  const tab = getActiveTab();
  if (!tab || (tab.kind !== "html-isolated-browser" && tab.kind !== "browser")) {
    return;
  }
  if (!breadcrumbSiblingsEl.classList.contains("hidden")) {
    await api.hideIsolatedViews();
    return;
  }
  const bounds = getIsolatedHostBounds();
  await api.setIsolatedViewBounds(tab.tabKey, bounds);
}

function renderWorkspaces(): void {
  workspaceListEl.innerHTML = "";
  if (activeWorkspaceId && workspaces.some((w) => w.workspaceId === activeWorkspaceId)) {
    newProjectChatBtn.classList.remove("hidden");
  } else {
    newProjectChatBtn.classList.add("hidden");
  }
  for (const ws of workspaces) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `nav-item${ws.workspaceId === activeWorkspaceId ? " active" : ""}`;
    btn.dataset.testid = `workspace-item-${ws.workspaceId}`;
    btn.title = ws.workspaceRoot;

    const label = document.createElement("span");
    label.textContent = ws.displayName;
    const tag = document.createElement("span");
    tag.className = "nav-item-meta";
    tag.textContent = "folder";
    btn.append(label, tag);

    btn.addEventListener("click", async () => {
      // Switching the visible sidebar project NEVER mutates the active chat's recorded workspace!
      activeWorkspaceId = ws.workspaceId;
      void api.syncUiState({ activeWorkspaceId });
      renderWorkspaces();
      await renderFileTree();
    });
    workspaceListEl.append(btn);
  }
}

function renderChatList(): void {
  chatListEl.innerHTML = "";
  for (const chat of chats) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `nav-item${chat.chatId === activeChatId ? " active" : ""}`;
    btn.dataset.testid = `chat-item-${chat.chatId}`;

    const label = document.createElement("span");
    label.textContent = chat.title;

    const pendingCount = pendingDialogsByChatId.get(chat.chatId)?.length ?? 0;
    const meta = document.createElement("span");
    meta.className = pendingCount > 0 ? "nav-item-meta pending-pill" : "nav-item-meta";
    meta.textContent =
      pendingCount > 0
        ? `approval (${pendingCount})`
        : chat.owningBinding.kind === "project"
          ? chat.owningBinding.workspaceDisplayName
          : "standalone";
    btn.append(label, meta);

    btn.addEventListener("click", () => {
      const current = getActiveChat();
      if (current) {
        current.composerDraft = composerInput.value;
        void api.syncUiState({
          activeChatId: chat.chatId,
          draftUpdate: { chatId: current.chatId, draft: current.composerDraft },
        });
      } else {
        void api.syncUiState({ activeChatId: chat.chatId });
      }
      activeChatId = chat.chatId;
      clearError();
      renderChatList();
      renderActiveChat();
    });
    chatListEl.append(btn);
  }
}

async function renderFileTree(): Promise<void> {
  const ws = getActiveWorkspace();
  fileTreeEl.innerHTML = "";
  if (!ws) {
    explorerHeadingEl.textContent = "Explorer";
    return;
  }
  explorerHeadingEl.textContent = `Explorer · ${ws.displayName}`;

  if (!expandedDirsByWorkspace.has(ws.workspaceId)) {
    expandedDirsByWorkspace.set(ws.workspaceId, new Set(["docs", "src", "web"]));
  }
  const expanded = expandedDirsByWorkspace.get(ws.workspaceId)!;

  async function renderDir(relativeDir: string, depth: number): Promise<void> {
    const entries: FolderEntry[] = await api.listDirectory(ws!.workspaceRoot, relativeDir);
    for (const entry of entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tree-row";
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.dataset.testid = `tree-entry-${entry.relativePath}`;

      const icon = document.createElement("span");
      icon.className = "tree-icon";
      const isExpanded = entry.isDirectory && expanded.has(entry.relativePath);
      icon.textContent = entry.isDirectory ? (isExpanded ? "▾" : "▸") : "·";

      const name = document.createElement("span");
      name.textContent = entry.name;
      row.append(icon, name);

      row.addEventListener("click", async () => {
        if (entry.isDirectory) {
          if (expanded.has(entry.relativePath)) {
            expanded.delete(entry.relativePath);
          } else {
            expanded.add(entry.relativePath);
          }
          await renderFileTree();
          return;
        }
        const projectBinding: ChatWorkspaceBinding = {
          kind: "project",
          workspaceId: ws!.workspaceId,
          workspaceRoot: ws!.workspaceRoot,
          workspaceDisplayName: ws!.displayName,
        };
        await openFileReference({
          chatId: activeChatId,
          messageId: "file-tree",
          isRestoredMessage: false,
          owningBinding: projectBinding,
          rawTarget: entry.relativePath,
        });
      });

      fileTreeEl.append(row);
      if (isExpanded) {
        await renderDir(entry.relativePath, depth + 1);
      }
    }
  }

  await renderDir("", 0);
}

function renderOnboardingSlot(): void {
  onboardingSlotEl.innerHTML = "";
  if (!unconfiguredModelChatIds.has(activeChatId)) {
    return;
  }
  const card = buildNoConfiguredModelCard(() => {
    unconfiguredModelChatIds.delete(activeChatId);
    renderOnboardingSlot();
  });
  onboardingSlotEl.append(card);
}

function syncComposerStreamingControls(): void {
  const isTurnActive = turnActiveChats.has(activeChatId);
  if (isTurnActive) {
    composerAbortBtn.classList.remove("hidden");
    composerSendBtn.disabled = true;
  } else {
    composerAbortBtn.classList.add("hidden");
    composerSendBtn.disabled = false;
  }
}

function syncStreamingCardInTranscript(): void {
  const existingCard = chatTranscriptEl.querySelector<HTMLElement>(
    '[data-testid="streaming-message-card"]',
  );
  const isTurnActive = turnActiveChats.has(activeChatId);
  const partialText = streamingTextByChatId.get(activeChatId);

  if (!isTurnActive && partialText === undefined) {
    existingCard?.remove();
    return;
  }

  let card = existingCard;
  let textEl: HTMLElement | null = card?.querySelector(".streaming-text") ?? null;
  if (!card || !textEl) {
    card = document.createElement("article");
    card.className = "message-card role-assistant streaming-card";
    card.dataset.testid = "streaming-message-card";

    const roleEl = document.createElement("div");
    roleEl.className = "message-role";
    roleEl.textContent = "assistant · streaming";

    textEl = document.createElement("p");
    textEl.className = "message-text streaming-text";
    textEl.dataset.testid = "streaming-message-text";

    card.append(roleEl, textEl);
    chatTranscriptEl.append(card);
  }

  textEl.textContent =
    partialText && partialText.length > 0 ? partialText : "Waiting for OMP response...";
  chatTranscriptEl.scrollTop = chatTranscriptEl.scrollHeight;
}

function reconcileChatDialogContainer(chatId: string): HTMLElement | null {
  const pendingDialogs = pendingDialogsByChatId.get(chatId) ?? [];
  const pendingOpenUrl = pendingOpenUrlByChatId.get(chatId);
  let container = dialogContainerByChatId.get(chatId) ?? null;

  if (pendingDialogs.length === 0 && !pendingOpenUrl) {
    if (container) {
      container.remove();
      dialogContainerByChatId.delete(chatId);
    }
    return null;
  }

  if (!container) {
    container = document.createElement("div");
    container.className = "chat-dialog-group";
    container.dataset.chatId = chatId;
    dialogContainerByChatId.set(chatId, container);
    chatDialogsEl.append(container);
  }

  // Reconcile open_url card inside this chat's container
  const existingOpenUrlEl = container.querySelector<HTMLElement>('[data-open-url-card="true"]');
  if (!pendingOpenUrl) {
    existingOpenUrlEl?.remove();
  } else if (!existingOpenUrlEl || existingOpenUrlEl.dataset.targetUrl !== pendingOpenUrl.url) {
    existingOpenUrlEl?.remove();
    const urlCard = buildOpenUrlCard(
      pendingOpenUrl,
      async (url) => {
        await openBrowserTab(url);
      },
      () => {
        pendingOpenUrlByChatId.delete(chatId);
        renderChatDialogs();
      },
    );
    urlCard.dataset.openUrlCard = "true";
    urlCard.dataset.targetUrl = pendingOpenUrl.url;
    container.prepend(urlCard);
  }

  // Reconcile dialog request cards by id so in-progress user typing/focus is preserved across
  // both streaming updates and chat switches.
  const activeIds = new Set(pendingDialogs.map((d) => d.id));
  for (const child of Array.from(container.querySelectorAll<HTMLElement>("[data-dialog-id]"))) {
    if (!activeIds.has(child.dataset.dialogId ?? "")) {
      child.remove();
    }
  }

  for (const req of pendingDialogs) {
    const alreadyMounted = Array.from(container.children).some(
      (el) => (el as HTMLElement).dataset.dialogId === req.id,
    );
    if (alreadyMounted) {
      continue;
    }
    const card = buildOmpDialogCard(
      req,
      async (response) => {
        const res = await api.respondToDialog(chatId, response);
        if (!res.ok) {
          if (res.error) {
            showError("OMP_DIALOG", res.error);
          }
          return false;
        }
        const remaining = (pendingDialogsByChatId.get(chatId) ?? []).filter(
          (item) => item.id !== req.id,
        );
        if (remaining.length > 0) {
          pendingDialogsByChatId.set(chatId, remaining);
        } else {
          pendingDialogsByChatId.delete(chatId);
        }
        renderChatList();
        renderChatDialogs();
        return true;
      },
      chatId,
    );
    card.dataset.dialogId = req.id;
    container.append(card);
  }

  return container;
}

function renderChatDialogs(): void {
  // Clean up any stale background chat containers that no longer have pending prompts
  for (const chatId of Array.from(dialogContainerByChatId.keys())) {
    if (chatId !== activeChatId) {
      const c = reconcileChatDialogContainer(chatId);
      if (c) {
        c.classList.add("hidden");
      }
    }
  }

  const activeContainer = reconcileChatDialogContainer(activeChatId);
  if (activeContainer) {
    activeContainer.classList.remove("hidden");
    chatDialogsEl.classList.remove("hidden");
  } else {
    chatDialogsEl.classList.add("hidden");
  }
}

function renderActiveChat(): void {
  const chat = getActiveChat();
  if (!chat) return;

  activeChatTitleEl.textContent = chat.title;
  if (chat.owningBinding.kind === "project") {
    activeChatScopeEl.textContent = `Workspace: ${chat.owningBinding.workspaceDisplayName}`;
    activeChatScopeEl.classList.remove("standalone");
    attachStandaloneBtn.classList.add("hidden");
    standaloneAttachmentsEl.classList.add("hidden");
    standaloneAttachmentsEl.innerHTML = "";
  } else {
    activeChatScopeEl.textContent = "Standalone (no project folder)";
    activeChatScopeEl.classList.add("standalone");
    attachStandaloneBtn.classList.remove("hidden");
    standaloneAttachmentsEl.classList.remove("hidden");
    standaloneAttachmentsEl.innerHTML = "";
    for (const attached of chat.owningBinding.attachedCanonicalPaths) {
      const pill = document.createElement("span");
      pill.className = "attachment-pill";
      pill.textContent = `Attached: ${attached.split(/[\\/]/).pop() ?? attached}`;
      pill.title = attached;
      standaloneAttachmentsEl.append(pill);
    }
  }

  composerInput.value = chat.composerDraft;
  renderOnboardingSlot();
  syncComposerStreamingControls();
  renderChatDialogs();

  chatTranscriptEl.innerHTML = "";
  for (const msg of chat.messages) {
    const card = document.createElement("article");
    card.className = `message-card role-${msg.role}`;

    const roleEl = document.createElement("div");
    roleEl.className = "message-role";
    roleEl.textContent = msg.isRestoredMessage ? `${msg.role} · restored` : msg.role;

    const textEl = document.createElement("p");
    textEl.className = "message-text";
    textEl.textContent = msg.text;

    card.append(roleEl, textEl);

    if (msg.links && msg.links.length > 0) {
      const chipList = document.createElement("div");
      chipList.className = "chip-list";
      for (const link of msg.links) {
        const isExternalUrl = link.kind === "external-url" || /^https?:\/\//i.test(link.rawTarget);
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = isExternalUrl ? "file-chip external-url-chip" : "file-chip";
        chip.dataset.testid = `chat-link-${link.id}`;
        chip.dataset.linkKind = isExternalUrl ? "external-url" : "file";

        if (isExternalUrl) {
          let hostLabel = link.rawTarget;
          try {
            hostLabel = new URL(link.rawTarget).host || link.rawTarget;
          } catch {
            // keep rawTarget fallback
          }
          // Untrusted-link protection: external web links MUST be visually distinguished from local file chips
          chip.title = `External URL (${hostLabel}): ${link.rawTarget}`;

          const badgeEl = document.createElement("span");
          badgeEl.className = "chip-badge";
          badgeEl.textContent = "WEB";

          const labelEl = document.createElement("span");
          labelEl.textContent = link.label;

          const hostEl = document.createElement("span");
          hostEl.className = "chip-host";
          hostEl.textContent = hostLabel;

          chip.append(badgeEl, labelEl, hostEl);
        } else {
          // Untrusted-link protection: expose true target in tooltip so deceptive labels cannot disguise path
          chip.title = link.anchor
            ? `${link.rawTarget}#L${link.anchor.startLine}${link.anchor.endLine ? `-L${link.anchor.endLine}` : ""}`
            : link.rawTarget;
          chip.textContent = link.label;
        }

        chip.addEventListener("click", async () => {
          await handleChatLinkClick(chat, msg.messageId, msg.isRestoredMessage, link);
        });
        chipList.append(chip);
      }
      card.append(chipList);
    }

    chatTranscriptEl.append(card);
  }

  syncStreamingCardInTranscript();
}

async function handleChatLinkClick(
  chat: ChatThread,
  messageId: string,
  isRestoredMessage: boolean,
  link: ChatLinkItem,
): Promise<void> {
  if (link.kind === "external-url" || /^https?:\/\//i.test(link.rawTarget)) {
    await openBrowserTab(link.rawTarget);
    return;
  }

  await openFileReference({
    chatId: chat.chatId,
    messageId,
    isRestoredMessage,
    owningBinding: chat.owningBinding,
    rawTarget: link.rawTarget,
    anchor: link.anchor,
  });
}

async function openFileReference(params: {
  chatId: string;
  messageId: string;
  isRestoredMessage: boolean;
  owningBinding: ChatWorkspaceBinding;
  rawTarget: string;
  anchor?: LineAnchor;
  preferSourceView?: boolean;
}): Promise<void> {
  clearError();
  hideSiblingPopover();

  const resolved = await api.resolveAndOpenLink(params);
  if (!resolved.ok) {
    showError(resolved.code, resolved.message);
    return;
  }

  const descriptor = resolved.descriptor;
  if (descriptor.viewerKind === "folder-explorer") {
    if (params.owningBinding.kind === "project") {
      activeWorkspaceId = params.owningBinding.workspaceId;
      const expanded =
        expandedDirsByWorkspace.get(params.owningBinding.workspaceId) ?? new Set<string>();
      expanded.add(descriptor.displayPath);
      expandedDirsByWorkspace.set(params.owningBinding.workspaceId, expanded);
      renderWorkspaces();
      await renderFileTree();
    }
    return;
  }

  // Case-insensitive tab deduplication: second click focuses existing tab!
  const existing = openTabs.find((t) => t.tabKey === descriptor.tabKey);
  if (existing) {
    if (params.anchor && existing.descriptor) {
      existing.descriptor.anchor = params.anchor;
    }
    await activateTab(existing.tabKey);
    return;
  }

  const title = descriptor.displayPath.split("/").pop() ?? descriptor.displayPath;
  const newTab: OpenTab = {
    tabKey: descriptor.tabKey,
    kind: descriptor.viewerKind,
    title: params.preferSourceView ? `${title} (source)` : title,
    descriptor,
    owningBinding: params.owningBinding,
    allowExternalNetwork: false,
  };

  if (descriptor.viewerKind === "source") {
    newTab.sourceData = await api.readSourceFile(descriptor.canonicalPath, params.owningBinding);
  } else if (descriptor.viewerKind === "pdf") {
    newTab.pdfBytes = await api.readPdfBytes(descriptor.canonicalPath, params.owningBinding);
    newTab.pdfPage = 1;
    newTab.pdfZoom = 1.0;
  } else if (descriptor.viewerKind === "html-isolated-browser") {
    newTab.browserUrl = descriptor.isolatedPreviewUrl;
    newTab.allowExternalNetwork = false;
  }

  openTabs.push(newTab);
  await activateTab(newTab.tabKey);
}

async function openBrowserTab(initialUrl = "about:blank"): Promise<void> {
  clearError();
  hideSiblingPopover();
  browserTabCounter += 1;
  const tabKey = `browser:${browserTabCounter}`;
  const url = /^https?:\/\//i.test(initialUrl) ? initialUrl : "https://example.com";
  const tab: OpenTab = {
    tabKey,
    kind: "browser",
    title: "Browser",
    browserUrl: url,
    allowExternalNetwork: true,
  };
  openTabs.push(tab);
  await activateTab(tabKey);
}

function renderTabStrip(): void {
  tabStripEl.innerHTML = "";
  for (const tab of openTabs) {
    const item = document.createElement("div");
    item.className = `tab-item${tab.tabKey === activeTabKey ? " active" : ""}`;
    item.dataset.testid = "preview-tab-item";
    item.dataset.tabKey = tab.tabKey;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.role = "tab";
    btn.className = "tab-btn";
    btn.setAttribute("aria-selected", String(tab.tabKey === activeTabKey));
    btn.dataset.testid = `preview-tab-${tab.tabKey}`;

    const kindTag = document.createElement("span");
    kindTag.className = "tab-kind-tag";
    kindTag.textContent =
      tab.kind === "html-isolated-browser" ? "html" : tab.kind === "browser" ? "web" : tab.kind;

    const label = document.createElement("span");
    label.textContent = tab.title;
    btn.append(kindTag, label);
    btn.addEventListener("click", async () => {
      await activateTab(tab.tabKey);
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "icon-btn";
    closeBtn.setAttribute("aria-label", `Close ${tab.title}`);
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await closeTab(tab.tabKey);
    });

    item.append(btn, closeBtn);
    tabStripEl.append(item);
  }
}

function renderBreadcrumbs(tab: OpenTab): void {
  hideSiblingPopover();
  if (!tab.descriptor) {
    breadcrumbsBarEl.classList.add("hidden");
    return;
  }

  breadcrumbsBarEl.classList.remove("hidden");
  breadcrumbsNavEl.innerHTML = "";
  const crumbs = tab.descriptor.breadcrumbs;

  crumbs.forEach((crumb, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "/";
      breadcrumbsNavEl.append(sep);
    }

    if (
      tab.descriptor!.parentBrowsingAllowed &&
      crumb.browsableRelativePath !== null &&
      tab.owningBinding?.kind === "project"
    ) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "crumb-btn";
      btn.dataset.testid = `breadcrumb-browsable-${index}`;
      btn.textContent = crumb.label;
      const projectBinding = tab.owningBinding;
      const targetRel = crumb.browsableRelativePath;
      btn.addEventListener("click", async () => {
        await toggleBreadcrumbSiblings(projectBinding, targetRel);
      });
      breadcrumbsNavEl.append(btn);
    } else {
      const span = document.createElement("span");
      span.className = "crumb-static";
      span.dataset.testid = `breadcrumb-static-${index}`;
      span.textContent = crumb.label;
      breadcrumbsNavEl.append(span);
    }
  });
}

async function toggleBreadcrumbSiblings(
  projectBinding: Extract<ChatWorkspaceBinding, { kind: "project" }>,
  relativeDir: string,
): Promise<void> {
  if (!breadcrumbSiblingsEl.classList.contains("hidden")) {
    hideSiblingPopover();
    const active = getActiveTab();
    if (active && (active.kind === "html-isolated-browser" || active.kind === "browser")) {
      await activateTab(activeTabKey);
    }
    return;
  }

  // Hide active isolated WebContentsView while popover is open to prevent HWND/overlay overlap
  await api.hideIsolatedViews();
  const entries = await api.listDirectory(projectBinding.workspaceRoot, relativeDir);
  breadcrumbSiblingsEl.innerHTML = "";
  for (const entry of entries) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tree-row";
    row.textContent = entry.isDirectory ? `▸ ${entry.name}/` : `· ${entry.name}`;
    row.addEventListener("click", async () => {
      hideSiblingPopover();
      await openFileReference({
        chatId: activeChatId,
        messageId: "breadcrumb",
        isRestoredMessage: false,
        owningBinding: projectBinding,
        rawTarget: entry.relativePath,
      });
    });
    breadcrumbSiblingsEl.append(row);
  }
  breadcrumbSiblingsEl.classList.remove("hidden");
}

function renderSourceContent(tab: OpenTab): void {
  sourceViewerEl.innerHTML = "";
  const data = tab.sourceData;
  if (!data) return;

  const anchor = tab.descriptor?.anchor;
  const lines = data.content.split(/\r?\n/);
  let firstHighlighted: HTMLElement | null = null;

  lines.forEach((text, idx) => {
    const lineNo = idx + 1;
    const isHighlighted =
      anchor !== undefined &&
      lineNo >= anchor.startLine &&
      lineNo <= (anchor.endLine ?? anchor.startLine);

    const row = document.createElement("div");
    row.className = `source-line${isHighlighted ? " highlighted" : ""}`;
    row.dataset.line = String(lineNo);

    const gutter = document.createElement("span");
    gutter.className = "source-gutter";
    gutter.textContent = String(lineNo);

    const code = document.createElement("span");
    code.className = "source-code";
    code.textContent = text;

    row.append(gutter, code);
    sourceViewerEl.append(row);
    if (isHighlighted && !firstHighlighted) {
      firstHighlighted = row;
    }
  });

  if (firstHighlighted) {
    (firstHighlighted as HTMLElement).scrollIntoView({ block: "center" });
  }
}

function renderToolbar(tab: OpenTab): void {
  previewToolbarEl.innerHTML = "";
  previewToolbarEl.classList.remove("hidden");

  if (tab.kind === "pdf") {
    const navGroup = document.createElement("div");
    navGroup.className = "toolbar-group";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "btn btn-subtle";
    prevBtn.textContent = "Prev";
    prevBtn.dataset.testid = "pdf-prev-page";

    const pageIndicator = document.createElement("span");
    pageIndicator.className = "toolbar-label";
    pageIndicator.dataset.testid = "pdf-page-indicator";
    pageIndicator.textContent = `Page ${tab.pdfPage ?? 1} / ${tab.pdfTotalPages ?? "?"}`;

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "btn btn-subtle";
    nextBtn.textContent = "Next";
    nextBtn.dataset.testid = "pdf-next-page";

    prevBtn.addEventListener("click", async () => {
      const next = await pdfController.goToPage((tab.pdfPage ?? 1) - 1);
      tab.pdfPage = next.currentPage;
      tab.pdfTotalPages = next.totalPages;
      renderToolbar(tab);
    });
    nextBtn.addEventListener("click", async () => {
      const next = await pdfController.goToPage((tab.pdfPage ?? 1) + 1);
      tab.pdfPage = next.currentPage;
      tab.pdfTotalPages = next.totalPages;
      renderToolbar(tab);
    });

    navGroup.append(prevBtn, pageIndicator, nextBtn);

    const zoomGroup = document.createElement("div");
    zoomGroup.className = "toolbar-group";

    const zoomOutBtn = document.createElement("button");
    zoomOutBtn.type = "button";
    zoomOutBtn.className = "btn btn-subtle";
    zoomOutBtn.textContent = "-";
    zoomOutBtn.dataset.testid = "pdf-zoom-out";

    const zoomIndicator = document.createElement("span");
    zoomIndicator.className = "toolbar-label";
    zoomIndicator.dataset.testid = "pdf-zoom-indicator";
    zoomIndicator.textContent = `${Math.round((tab.pdfZoom ?? 1) * 100)}%`;

    const zoomInBtn = document.createElement("button");
    zoomInBtn.type = "button";
    zoomInBtn.className = "btn btn-subtle";
    zoomInBtn.textContent = "+";
    zoomInBtn.dataset.testid = "pdf-zoom-in";

    zoomOutBtn.addEventListener("click", async () => {
      const next = await pdfController.setZoom((tab.pdfZoom ?? 1) - 0.25);
      tab.pdfZoom = next.zoom;
      renderToolbar(tab);
    });
    zoomInBtn.addEventListener("click", async () => {
      const next = await pdfController.setZoom((tab.pdfZoom ?? 1) + 0.25);
      tab.pdfZoom = next.zoom;
      renderToolbar(tab);
    });

    zoomGroup.append(zoomOutBtn, zoomIndicator, zoomInBtn);
    previewToolbarEl.append(navGroup, zoomGroup);
    return;
  }

  if (tab.kind === "source") {
    const left = document.createElement("div");
    left.className = "toolbar-group";
    const info = document.createElement("span");
    info.className = "toolbar-label";
    info.dataset.testid = "source-meta";
    const anchorText = tab.descriptor?.anchor
      ? ` · L${tab.descriptor.anchor.startLine}${tab.descriptor.anchor.endLine ? `-L${tab.descriptor.anchor.endLine}` : ""}`
      : "";
    info.textContent = `${tab.sourceData?.language ?? "text"} · ${tab.sourceData?.lineCount ?? 0} lines${anchorText}`;
    left.append(info);
    previewToolbarEl.append(left);
    return;
  }

  if (tab.kind === "html-isolated-browser") {
    const left = document.createElement("div");
    left.className = "toolbar-group";
    const originBadge = document.createElement("span");
    originBadge.className = "toolbar-label";
    originBadge.dataset.testid = "html-preview-origin";
    originBadge.textContent = tab.browserUrl ?? "";
    left.append(originBadge);

    const right = document.createElement("div");
    right.className = "toolbar-group";

    const netToggleBtn = document.createElement("button");
    netToggleBtn.type = "button";
    netToggleBtn.className = "btn btn-subtle";
    netToggleBtn.dataset.testid = "html-network-toggle";
    netToggleBtn.textContent = tab.allowExternalNetwork
      ? "External Network: Allowed"
      : "External Network: Blocked";
    netToggleBtn.addEventListener("click", async () => {
      const res = await api.setIsolatedViewNetworkPolicy(tab.tabKey, !tab.allowExternalNetwork);
      if (res.ok) {
        tab.allowExternalNetwork = res.allowExternalNetwork;
        renderToolbar(tab);
      }
    });

    const viewSourceBtn = document.createElement("button");
    viewSourceBtn.type = "button";
    viewSourceBtn.className = "btn btn-subtle";
    viewSourceBtn.dataset.testid = "html-view-source-btn";
    viewSourceBtn.textContent = "View Source";
    viewSourceBtn.addEventListener("click", async () => {
      if (!tab.descriptor || !tab.owningBinding) return;
      await openFileReference({
        chatId: activeChatId,
        messageId: "view-source",
        isRestoredMessage: false,
        owningBinding: tab.owningBinding,
        rawTarget: tab.descriptor.canonicalPath,
        preferSourceView: true,
      });
    });

    right.append(netToggleBtn, viewSourceBtn);
    previewToolbarEl.append(left, right);
    return;
  }

  if (tab.kind === "browser") {
    const form = document.createElement("form");
    form.className = "toolbar-group";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "url-input";
    input.value = tab.browserUrl ?? "";
    input.dataset.testid = "browser-url-input";
    const goBtn = document.createElement("button");
    goBtn.type = "submit";
    goBtn.className = "btn btn-subtle";
    goBtn.textContent = "Go";
    form.append(input, goBtn);

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      clearError();
      const res = await api.navigateBrowserView(tab.tabKey, input.value.trim());
      if (!res.ok) {
        showError("BLOCKED_NAVIGATION", res.error);
      } else {
        tab.browserUrl = res.url;
      }
    });

    const badge = document.createElement("span");
    badge.className = "toolbar-label";
    badge.textContent = "Isolated profile";
    previewToolbarEl.append(form, badge);
  }
}

async function activateTab(tabKey: string | null): Promise<void> {
  activeTabKey = tabKey;
  renderTabStrip();

  const tab = getActiveTab();
  if (!tab) {
    await api.hideIsolatedViews();
    breadcrumbsBarEl.classList.add("hidden");
    previewToolbarEl.classList.add("hidden");
    sourceViewerEl.classList.add("hidden");
    pdfViewerEl.classList.add("hidden");
    isolatedViewHostEl.classList.add("hidden");
    previewEmptyEl.classList.remove("hidden");
    return;
  }

  previewEmptyEl.classList.add("hidden");
  renderBreadcrumbs(tab);
  renderToolbar(tab);

  if (tab.kind === "source") {
    await api.hideIsolatedViews();
    pdfViewerEl.classList.add("hidden");
    isolatedViewHostEl.classList.add("hidden");
    sourceViewerEl.classList.remove("hidden");
    renderSourceContent(tab);
    return;
  }

  if (tab.kind === "pdf") {
    await api.hideIsolatedViews();
    sourceViewerEl.classList.add("hidden");
    isolatedViewHostEl.classList.add("hidden");
    pdfViewerEl.classList.add("hidden");
    await pdfController.destroy();
    if (tab.pdfBytes) {
      try {
        const state = await pdfController.loadBytes(tab.pdfBytes.slice());
        tab.pdfPage = state.currentPage;
        tab.pdfTotalPages = state.totalPages;
        tab.pdfZoom = state.zoom;
        pdfViewerEl.classList.remove("hidden");
        renderToolbar(tab);
      } catch (err) {
        await pdfController.destroy();
        tab.pdfPage = 0;
        tab.pdfTotalPages = 0;
        renderToolbar(tab);
        showError(
          "PDF_LOAD_ERROR",
          `Could not render PDF "${tab.title}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return;
  }

  if (tab.kind === "html-isolated-browser" || tab.kind === "browser") {
    sourceViewerEl.classList.add("hidden");
    pdfViewerEl.classList.add("hidden");
    delete isolatedViewHostEl.dataset.viewReady;
    isolatedViewHostEl.classList.remove("hidden");
    // Wait one layout frame so isolatedViewHostEl has final non-zero bounds
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    const bounds = getIsolatedHostBounds();
    const res = await api.openIsolatedView({
      tabKey: tab.tabKey,
      kind: tab.kind === "html-isolated-browser" ? "html-preview" : "browser",
      url: tab.browserUrl ?? "about:blank",
      workspaceToken: tab.descriptor?.workspaceToken,
      allowExternalNetwork: tab.allowExternalNetwork ?? false,
      bounds,
    });
    if (!res.ok) {
      showError("PREVIEW_BLOCKED", res.error);
    } else {
      isolatedViewHostEl.dataset.viewReady = "true";
    }
  }
}

async function closeTab(tabKey: string): Promise<void> {
  const idx = openTabs.findIndex((t) => t.tabKey === tabKey);
  if (idx === -1) return;
  const [removed] = openTabs.splice(idx, 1);
  if (removed && (removed.kind === "html-isolated-browser" || removed.kind === "browser")) {
    await api.closeIsolatedView(tabKey);
  }
  if (activeTabKey === tabKey) {
    const next = openTabs[idx] ?? openTabs[idx - 1] ?? null;
    await activateTab(next ? next.tabKey : null);
  } else {
    renderTabStrip();
  }
}

dismissErrorBtn.addEventListener("click", () => clearError());

openFolderBtn.addEventListener("click", async () => {
  const current = getActiveChat();
  if (current) {
    current.composerDraft = composerInput.value;
    await api.syncUiState({
      draftUpdate: { chatId: current.chatId, draft: current.composerDraft },
    });
  }
  const opened = await api.openFolderDialog();
  if (!opened) return;
  const { workspace: ws, chat } = opened;
  if (!workspaces.some((w) => w.workspaceId === ws.workspaceId)) {
    workspaces.push(ws);
  }
  const existingIdx = chats.findIndex((c) => c.chatId === chat.chatId);
  if (existingIdx === -1) {
    chats.push(chat);
  }
  activeWorkspaceId = ws.workspaceId;
  activeChatId = chat.chatId;
  clearError();
  renderWorkspaces();
  renderChatList();
  renderActiveChat();
  await renderFileTree();
});

newProjectChatBtn.addEventListener("click", async () => {
  if (!activeWorkspaceId) return;
  const current = getActiveChat();
  if (current) {
    current.composerDraft = composerInput.value;
    await api.syncUiState({
      draftUpdate: { chatId: current.chatId, draft: current.composerDraft },
    });
  }
  const created = await api.createProjectChat(activeWorkspaceId);
  if (!created) return;
  chats.push(created);
  activeChatId = created.chatId;
  clearError();
  renderChatList();
  renderActiveChat();
});

newBrowserTabBtn.addEventListener("click", async () => {
  await openBrowserTab("https://example.com");
});

attachStandaloneBtn.addEventListener("click", async () => {
  const chat = getActiveChat();
  if (!chat || chat.owningBinding.kind !== "standalone") return;
  chat.composerDraft = composerInput.value;
  await api.syncUiState({
    draftUpdate: { chatId: chat.chatId, draft: chat.composerDraft },
  });
  const attachedPath = await api.attachStandaloneFileDialog(chat.chatId);
  if (!attachedPath) return;
  if (!chat.owningBinding.attachedCanonicalPaths.includes(attachedPath)) {
    chat.owningBinding.attachedCanonicalPaths.push(attachedPath);
  }
  renderActiveChat();
});

composerInput.addEventListener("input", () => {
  const chat = getActiveChat();
  if (!chat) return;
  const draftValue = composerInput.value;
  chat.composerDraft = draftValue;
  const targetChatId = chat.chatId;
  if (draftSyncTimer) {
    clearTimeout(draftSyncTimer);
  }
  draftSyncTimer = setTimeout(() => {
    draftSyncTimer = null;
    void api.syncUiState({
      draftUpdate: { chatId: targetChatId, draft: draftValue },
    });
  }, 180);
});

function flushPendingDraftSync(): void {
  if (!draftSyncTimer) {
    return;
  }
  clearTimeout(draftSyncTimer);
  draftSyncTimer = null;
  const chat = getActiveChat();
  if (chat) {
    chat.composerDraft = composerInput.value;
    void api.syncUiState({
      draftUpdate: { chatId: chat.chatId, draft: chat.composerDraft },
    });
  }
}

composerInput.addEventListener("blur", () => {
  flushPendingDraftSync();
});

window.addEventListener("beforeunload", () => {
  flushPendingDraftSync();
});

composerInput.addEventListener("keydown", (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
    ev.preventDefault();
    composerForm.requestSubmit();
  }
});

composerAbortBtn.addEventListener("click", async () => {
  const targetChatId = activeChatId;
  if (!targetChatId) return;
  composerAbortBtn.disabled = true;
  try {
    await api.abortTurn(targetChatId);
  } finally {
    composerAbortBtn.disabled = false;
  }
});

composerForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const chat = getActiveChat();
  const text = composerInput.value.trim();
  if (!chat || !text || turnActiveChats.has(chat.chatId)) return;

  if (draftSyncTimer) {
    clearTimeout(draftSyncTimer);
    draftSyncTimer = null;
  }
  composerInput.value = "";
  chat.composerDraft = "";

  turnActiveChats.add(chat.chatId);
  streamingTextByChatId.set(chat.chatId, "");
  clearError();
  syncStreamingCardInTranscript();
  syncComposerStreamingControls();

  const submittedChatId = chat.chatId;
  const res = await api.sendPrompt(submittedChatId, text);
  if (!res.ok) {
    turnActiveChats.delete(submittedChatId);
    streamingTextByChatId.delete(submittedChatId);
    if (activeChatId === submittedChatId) {
      syncStreamingCardInTranscript();
      syncComposerStreamingControls();
      if (
        res.error &&
        !unconfiguredModelChatIds.has(submittedChatId) &&
        linkErrorBannerEl.classList.contains("hidden")
      ) {
        showError("OMP_RUNTIME", res.error);
      }
    }
  } else if (res.agentInvoked === false) {
    // Local commands (e.g. /session info) complete on the prompt ack without a later prompt_result.
    turnActiveChats.delete(submittedChatId);
    streamingTextByChatId.delete(submittedChatId);
    if (activeChatId === submittedChatId) {
      syncStreamingCardInTranscript();
      syncComposerStreamingControls();
    }
  }
});

const resizeObserver = new ResizeObserver(() => {
  void syncActiveIsolatedViewBounds();
});
resizeObserver.observe(isolatedViewHostEl);
window.addEventListener("resize", () => {
  void syncActiveIsolatedViewBounds();
});

const runtimeBadgeEl = document.getElementById("runtime-badge");

function handleIncomingChatMessage(payload: { chatId: string; message: ChatMessage }): void {
  const targetChat = chats.find((c) => c.chatId === payload.chatId);
  if (!targetChat) {
    return;
  }
  if (!targetChat.messages.some((m) => m.messageId === payload.message.messageId)) {
    targetChat.messages.push(payload.message);
  }
  if (payload.chatId === activeChatId) {
    renderActiveChat();
  }
}

function handleIncomingOmpEvent(payload: {
  chatId: string;
  event: import("../shared/contracts").OmpAdapterEvent;
}): void {
  const { chatId, event } = payload;

  if (event.type === "ready") {
    unconfiguredModelChatIds.delete(chatId);
    if (runtimeBadgeEl) {
      runtimeBadgeEl.textContent = `OMP v${event.metadata.ompVersion} · RPC v2 · always-ask`;
    }
    if (chatId === activeChatId) {
      renderOnboardingSlot();
    }
    return;
  }

  if (event.type === "state") {
    if (event.state.isStreaming) {
      turnActiveChats.add(chatId);
    } else if (event.state.isSettled) {
      turnActiveChats.delete(chatId);
      streamingTextByChatId.delete(chatId);
    }
    if (chatId === activeChatId) {
      syncStreamingCardInTranscript();
      syncComposerStreamingControls();
    }
    return;
  }

  if (event.type === "message_update") {
    turnActiveChats.add(chatId);
    const prev = streamingTextByChatId.get(chatId) ?? "";
    const next = extractStreamingUpdateText(event.payload, prev);
    if (next !== null) {
      streamingTextByChatId.set(chatId, next);
    }
    if (chatId === activeChatId) {
      syncStreamingCardInTranscript();
      syncComposerStreamingControls();
    }
    return;
  }

  if (event.type === "message_end") {
    streamingTextByChatId.delete(chatId);
    if (chatId === activeChatId) {
      syncStreamingCardInTranscript();
    }
    return;
  }

  if (event.type === "prompt_result") {
    streamingTextByChatId.delete(chatId);
    turnActiveChats.delete(chatId);
    if (event.status === "aborted" && pendingDialogsByChatId.has(chatId)) {
      pendingDialogsByChatId.delete(chatId);
      renderChatList();
      renderChatDialogs();
    }
    if (chatId === activeChatId) {
      syncStreamingCardInTranscript();
      syncComposerStreamingControls();
      if (event.status === "error" && event.error) {
        showError("OMP_PROMPT_ERROR", event.error);
      }
    }
    return;
  }

  if (event.type === "session_settled") {
    streamingTextByChatId.delete(chatId);
    turnActiveChats.delete(chatId);
    if (chatId === activeChatId) {
      syncStreamingCardInTranscript();
      syncComposerStreamingControls();
    }
    return;
  }

  if (event.type === "dialog_request") {
    const list = pendingDialogsByChatId.get(chatId) ?? [];
    const filtered = list.filter((d) => d.id !== event.request.id);
    filtered.push(event.request);
    pendingDialogsByChatId.set(chatId, filtered);
    renderChatList();
    renderChatDialogs();
    return;
  }

  if (event.type === "dialog_cancel") {
    const list = pendingDialogsByChatId.get(chatId);
    if (list) {
      const remaining = list.filter((d) => d.id !== event.targetId);
      if (remaining.length > 0) {
        pendingDialogsByChatId.set(chatId, remaining);
      } else {
        pendingDialogsByChatId.delete(chatId);
      }
      renderChatList();
      renderChatDialogs();
    }
    return;
  }

  if (event.type === "open_url") {
    const targetUrl = event.launchUrl ?? event.url;
    if (/^https?:\/\//i.test(targetUrl)) {
      pendingOpenUrlByChatId.set(chatId, {
        url: targetUrl,
        displayUrl: event.url,
        instructions: event.instructions,
      });
      renderChatDialogs();
    } else if (chatId === activeChatId) {
      showError("BLOCKED_URL_SCHEME", "OMP requested an unsupported non-HTTP URL scheme.");
    }
    return;
  }

  if (event.type === "notify") {
    if (event.level === "error" && chatId === activeChatId) {
      showError("OMP_NOTIFY", event.message);
    }
    return;
  }

  if (event.type === "transport_error") {
    if (!event.recoverable) {
      streamingTextByChatId.delete(chatId);
      turnActiveChats.delete(chatId);
      pendingDialogsByChatId.delete(chatId);
      renderChatList();
      renderChatDialogs();
    }
    if (event.code === "NO_CONFIGURED_MODEL") {
      unconfiguredModelChatIds.add(chatId);
      if (chatId === activeChatId) {
        clearError();
        renderOnboardingSlot();
        syncStreamingCardInTranscript();
        syncComposerStreamingControls();
      }
      return;
    }
    if (chatId === activeChatId) {
      syncStreamingCardInTranscript();
      syncComposerStreamingControls();
      showError(event.code, event.message);
    }
  }
}

async function boot(): Promise<void> {
  api.onChatMessage((payload) => {
    handleIncomingChatMessage(payload);
  });
  api.onOmpEvent((payload) => {
    handleIncomingOmpEvent(payload);
  });

  const bootstrap = await api.getBootstrap();
  workspaces = bootstrap.workspaces;
  activeWorkspaceId = bootstrap.activeWorkspaceId;
  chats = bootstrap.chats;
  activeChatId = bootstrap.activeChatId;

  if (bootstrap.diagnostics.ompStatus === "no-configured-model") {
    unconfiguredModelChatIds.add(activeChatId);
  } else if (bootstrap.diagnostics.ompVersion && runtimeBadgeEl) {
    runtimeBadgeEl.textContent = `OMP v${bootstrap.diagnostics.ompVersion} · RPC v2 · always-ask`;
  }

  renderWorkspaces();
  renderChatList();
  renderActiveChat();
  await renderFileTree();
}

void boot();

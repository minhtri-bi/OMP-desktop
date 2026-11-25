import fs from "node:fs";
import path from "node:path";
import type {
  ChatLinkItem,
  ChatMessage,
  ChatThread,
  ChatWorkspaceBinding,
  LineAnchor,
  WorkspaceDescriptor,
} from "../shared/contracts";
import {
  canonicalizeExistingPath,
  deriveWorkspaceDisplayName,
  isAbsolutePathCrossPlatform,
  normalizeForComparison,
  normalizePathSlashes,
} from "./path-resolver";

export interface PersistedDesktopState {
  version: 1;
  workspaces: WorkspaceDescriptor[];
  activeWorkspaceId: string | null;
  chats: ChatThread[];
  activeChatId: string;
}

/**
 * Allocates a workspace ID that does not collide with any active workspace OR any retained
 * project chat binding (including chats whose original workspace directory is temporarily unavailable).
 */
export function allocateWorkspaceId(
  workspaces: Iterable<WorkspaceDescriptor>,
  chats: Iterable<ChatThread>,
  explicitId?: string,
): string {
  if (explicitId) {
    return explicitId;
  }
  const reserved = new Set<string>();
  for (const ws of workspaces) {
    reserved.add(ws.workspaceId);
  }
  for (const chat of chats) {
    if (chat.owningBinding.kind === "project") {
      reserved.add(chat.owningBinding.workspaceId);
    }
  }
  let seq = 1;
  let candidate = `ws-${seq}`;
  while (reserved.has(candidate)) {
    seq += 1;
    candidate = `ws-${seq}`;
  }
  return candidate;
}

/**
 * Finds an existing project chat matching BOTH workspaceId and canonical workspaceRoot,
 * preventing a newly opened folder from ever inheriting an unrelated retained chat.
 */
export function findMatchingProjectChat(
  chats: Iterable<ChatThread>,
  workspace: WorkspaceDescriptor,
): ChatThread | undefined {
  const targetRoot = normalizeForComparison(workspace.workspaceRoot);
  for (const existing of chats) {
    if (
      existing.owningBinding.kind === "project" &&
      existing.owningBinding.workspaceId === workspace.workspaceId &&
      normalizeForComparison(existing.owningBinding.workspaceRoot) === targetRoot
    ) {
      return existing;
    }
  }
  return undefined;
}

function isSafeLocalRootSyntax(candidate: string): boolean {
  if (!candidate || /[\x00-\x1f]/.test(candidate)) {
    return false;
  }
  if (candidate.startsWith("\\\\") || candidate.startsWith("//")) {
    return false;
  }
  return true;
}

function validateAndCanonicalizeWorkspace(raw: unknown): WorkspaceDescriptor | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  if (
    typeof rec.workspaceId !== "string" ||
    !rec.workspaceId ||
    typeof rec.workspaceRoot !== "string" ||
    !isSafeLocalRootSyntax(rec.workspaceRoot) ||
    typeof rec.displayName !== "string"
  ) {
    return null;
  }

  try {
    const ls = fs.lstatSync(rec.workspaceRoot);
    if (!ls.isDirectory() || ls.isSymbolicLink()) {
      return null;
    }
    const canonicalRoot = canonicalizeExistingPath(rec.workspaceRoot);
    const displayName = rec.displayName.trim()
      ? rec.displayName
      : deriveWorkspaceDisplayName(canonicalRoot);
    return {
      workspaceId: rec.workspaceId,
      workspaceRoot: canonicalRoot,
      displayName,
    };
  } catch {
    return null;
  }
}

function sanitizeLineAnchor(raw: unknown): LineAnchor | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.startLine !== "number" || !Number.isSafeInteger(rec.startLine) || rec.startLine < 1) {
    return undefined;
  }
  if (
    typeof rec.endLine === "number" &&
    Number.isSafeInteger(rec.endLine) &&
    rec.endLine >= rec.startLine
  ) {
    return { startLine: rec.startLine, endLine: rec.endLine };
  }
  return { startLine: rec.startLine };
}

function sanitizeLinks(raw: unknown): ChatLinkItem[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const items: ChatLinkItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as Record<string, unknown>;
    if (
      typeof rec.id !== "string" ||
      !rec.id ||
      typeof rec.label !== "string" ||
      typeof rec.rawTarget !== "string" ||
      !rec.rawTarget
    ) {
      continue;
    }
    items.push({
      id: rec.id,
      label: rec.label,
      rawTarget: rec.rawTarget,
      anchor: sanitizeLineAnchor(rec.anchor),
      kind: rec.kind === "external-url" || rec.kind === "file" ? rec.kind : undefined,
    });
  }
  return items.length > 0 ? items : undefined;
}

function sanitizeBinding(raw: unknown, fallbackChatId: string): ChatWorkspaceBinding | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  if (rec.kind === "project") {
    if (
      typeof rec.workspaceId !== "string" ||
      !rec.workspaceId ||
      typeof rec.workspaceRoot !== "string" ||
      !isSafeLocalRootSyntax(rec.workspaceRoot) ||
      typeof rec.workspaceDisplayName !== "string"
    ) {
      return null;
    }
    // Preserve the recorded workspaceRoot even if moved/deleted on disk so restored chat links
    // report WORKSPACE_UNAVAILABLE / STALE_LINK rather than losing chat history or crashing startup.
    let rootToStore = rec.workspaceRoot;
    try {
      const ls = fs.lstatSync(rec.workspaceRoot);
      if (ls.isDirectory() && !ls.isSymbolicLink()) {
        rootToStore = canonicalizeExistingPath(rec.workspaceRoot);
      }
    } catch {
      // keep recorded rootToStore so resolver surfaces WORKSPACE_UNAVAILABLE cleanly
    }
    // Normalize empty display names (e.g. drive roots like D:\ saved with empty basename) so chats are retained.
    const workspaceDisplayName = rec.workspaceDisplayName.trim()
      ? rec.workspaceDisplayName
      : deriveWorkspaceDisplayName(rootToStore);
    return {
      kind: "project",
      workspaceId: rec.workspaceId,
      workspaceRoot: rootToStore,
      workspaceDisplayName,
    };
  }

  if (rec.kind === "standalone") {
    const rawList = Array.isArray(rec.attachedCanonicalPaths) ? rec.attachedCanonicalPaths : [];
    const safePaths: string[] = [];
    const seen = new Set<string>();
    for (const item of rawList) {
      if (
        typeof item !== "string" ||
        !isSafeLocalRootSyntax(item) ||
        !isAbsolutePathCrossPlatform(item)
      ) {
        continue;
      }
      const key = normalizePathSlashes(item);
      if (!seen.has(key)) {
        seen.add(key);
        safePaths.push(item);
      }
    }
    return {
      kind: "standalone",
      chatId: typeof rec.chatId === "string" && rec.chatId ? rec.chatId : fallbackChatId,
      attachedCanonicalPaths: safePaths,
    };
  }

  return null;
}

function sanitizeChat(raw: unknown): ChatThread | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.chatId !== "string" || !rec.chatId || typeof rec.title !== "string") {
    return null;
  }
  const binding = sanitizeBinding(rec.owningBinding, rec.chatId);
  if (!binding) {
    return null;
  }
  const trimmedTitle = rec.title.trim();
  const normalizedTitle =
    trimmedTitle && trimmedTitle !== "Chat"
      ? rec.title
      : binding.kind === "project"
        ? `${binding.workspaceDisplayName} Chat`
        : "Standalone Chat";

  const rawMessages = Array.isArray(rec.messages) ? rec.messages : [];
  const messages: ChatMessage[] = [];
  for (const m of rawMessages) {
    if (!m || typeof m !== "object") {
      continue;
    }
    const mRec = m as Record<string, unknown>;
    if (
      typeof mRec.messageId !== "string" ||
      !mRec.messageId ||
      (mRec.role !== "user" && mRec.role !== "assistant" && mRec.role !== "system") ||
      typeof mRec.text !== "string"
    ) {
      continue;
    }
    // Every message restored from disk across an app restart is historical (`isRestoredMessage: true`)
    // so deleted files accurately report STALE_LINK rather than live MISSING_FILE.
    messages.push({
      messageId: mRec.messageId,
      role: mRec.role,
      text: mRec.text,
      isRestoredMessage: true,
      links: sanitizeLinks(mRec.links),
    });
  }

  return {
    chatId: rec.chatId,
    title: normalizedTitle,
    owningBinding: binding,
    messages,
    composerDraft: typeof rec.composerDraft === "string" ? rec.composerDraft : "",
  };
}

export class DesktopStateStore {
  private readonly filePath: string;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, "desktop-state.json");
  }

  getFilePath(): string {
    return this.filePath;
  }

  load(): PersistedDesktopState | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }
    try {
      const rawText = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(rawText) as unknown;
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      const root = parsed as Record<string, unknown>;
      if (root.version !== 1 || !Array.isArray(root.chats) || root.chats.length === 0) {
        return null;
      }

      const rawWorkspaces = Array.isArray(root.workspaces) ? root.workspaces : [];
      const workspaces: WorkspaceDescriptor[] = [];
      const validWsIds = new Set<string>();
      for (const item of rawWorkspaces) {
        const ws = validateAndCanonicalizeWorkspace(item);
        if (ws && !validWsIds.has(ws.workspaceId)) {
          validWsIds.add(ws.workspaceId);
          workspaces.push(ws);
        }
      }

      const chats: ChatThread[] = [];
      const seenChatIds = new Set<string>();
      for (const item of root.chats) {
        const chat = sanitizeChat(item);
        if (chat && !seenChatIds.has(chat.chatId)) {
          seenChatIds.add(chat.chatId);
          chats.push(chat);
        }
      }
      if (chats.length === 0) {
        return null;
      }

      const requestedWsId =
        typeof root.activeWorkspaceId === "string" ? root.activeWorkspaceId : null;
      const activeWorkspaceId =
        requestedWsId && validWsIds.has(requestedWsId)
          ? requestedWsId
          : (workspaces[0]?.workspaceId ?? null);

      const requestedChatId = typeof root.activeChatId === "string" ? root.activeChatId : "";
      const activeChatId = seenChatIds.has(requestedChatId) ? requestedChatId : chats[0]!.chatId;

      return {
        version: 1,
        workspaces,
        activeWorkspaceId,
        chats,
        activeChatId,
      };
    } catch {
      return null;
    }
  }

  save(state: Omit<PersistedDesktopState, "version">): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload: PersistedDesktopState = {
      version: 1,
      workspaces: state.workspaces,
      activeWorkspaceId: state.activeWorkspaceId,
      chats: state.chats,
      activeChatId: state.activeChatId,
    };
    const serialized = JSON.stringify(payload, null, 2);
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, serialized, "utf8");
    try {
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      fs.copyFileSync(tmpPath, this.filePath);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore best-effort temp cleanup
      }
    }
  }
}

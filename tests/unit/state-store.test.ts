import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeExistingPath,
  deriveWorkspaceDisplayName,
  resolveMessageFileLink,
} from "../../src/main/path-resolver";
import {
  allocateWorkspaceId,
  DesktopStateStore,
  findMatchingProjectChat,
} from "../../src/main/state-store";
import { buildAskQuestionAnswer } from "../../src/renderer/dialog-cards";
import { extractAssistantText, extractStreamingUpdateText } from "../../src/shared/omp-message";

describe("DesktopStateStore (durable workspace & chat persistence)", () => {
  it("persists workspaces, chats, drafts, and marks restored messages isRestoredMessage: true", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-state-store-"));
    try {
      const wsDir = path.join(tmp, "proj-alpha");
      const userDataDir = path.join(tmp, "user-data");
      fs.mkdirSync(wsDir, { recursive: true });
      const fileInWs = path.join(wsDir, "notes.md");
      fs.writeFileSync(fileInWs, "# Notes\n", "utf8");

      const canonicalWs = canonicalizeExistingPath(wsDir);
      const store = new DesktopStateStore(userDataDir);

      store.save({
        workspaces: [{ workspaceId: "ws-1", workspaceRoot: canonicalWs, displayName: "proj-alpha" }],
        activeWorkspaceId: "ws-1",
        activeChatId: "chat-ws-1",
        chats: [
          {
            chatId: "chat-ws-1",
            title: "proj-alpha Chat",
            owningBinding: {
              kind: "project",
              workspaceId: "ws-1",
              workspaceRoot: canonicalWs,
              workspaceDisplayName: "proj-alpha",
            },
            messages: [
              {
                messageId: "m-live-1",
                role: "assistant",
                text: "See [notes](notes.md).",
                isRestoredMessage: false,
                links: [{ id: "m-live-1-link-0", label: "notes", rawTarget: "notes.md", kind: "file" }],
              },
            ],
            composerDraft: "unsent draft text",
          },
        ],
      });

      const reloaded = store.load();
      expect(reloaded).not.toBeNull();
      expect(reloaded!.activeWorkspaceId).toBe("ws-1");
      expect(reloaded!.activeChatId).toBe("chat-ws-1");
      expect(reloaded!.chats[0]!.composerDraft).toBe("unsent draft text");
      expect(reloaded!.chats[0]!.messages[0]!.isRestoredMessage).toBe(true);

      // Delete file after reload -> restored message link reports STALE_LINK instead of live MISSING_FILE
      fs.unlinkSync(fileInWs);
      const res = resolveMessageFileLink({
        chatId: "chat-ws-1",
        messageId: "m-live-1",
        isRestoredMessage: reloaded!.chats[0]!.messages[0]!.isRestoredMessage,
        owningBinding: reloaded!.chats[0]!.owningBinding,
        rawTarget: "notes.md",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("STALE_LINK");
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles deleted workspaces, reserves their workspace IDs, and requires canonical root match before reusing a chat", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-state-missing-ws-"));
    try {
      const wsGone = path.join(tmp, "deleted-ws");
      const wsNew = path.join(tmp, "new-ws");
      const userDataDir = path.join(tmp, "user-data");
      fs.mkdirSync(wsGone, { recursive: true });
      fs.mkdirSync(wsNew, { recursive: true });
      const canonicalGone = canonicalizeExistingPath(wsGone);
      const canonicalNew = canonicalizeExistingPath(wsNew);

      const store = new DesktopStateStore(userDataDir);
      store.save({
        workspaces: [{ workspaceId: "ws-1", workspaceRoot: canonicalGone, displayName: "deleted-ws" }],
        activeWorkspaceId: "ws-1",
        activeChatId: "chat-ws-1-1",
        chats: [
          {
            chatId: "chat-ws-1-1",
            title: "Deleted Project Chat",
            owningBinding: {
              kind: "project",
              workspaceId: "ws-1",
              workspaceRoot: canonicalGone,
              workspaceDisplayName: "deleted-ws",
            },
            messages: [{ messageId: "m1", role: "user", text: "hello", isRestoredMessage: false }],
            composerDraft: "",
          },
        ],
      });

      // Remove workspace directory before reloading state
      fs.rmSync(wsGone, { recursive: true, force: true });

      const reloaded = store.load();
      expect(reloaded).not.toBeNull();
      expect(reloaded!.workspaces).toEqual([]);
      expect(reloaded!.activeWorkspaceId).toBeNull();
      // Chat history itself is preserved so user never loses saved transcripts
      expect(reloaded!.chats).toHaveLength(1);

      // Opening a new folder after restart MUST NOT reuse ws-1 held by the retained chat!
      const nextId = allocateWorkspaceId(reloaded!.workspaces, reloaded!.chats);
      expect(nextId).toBe("ws-2");

      // Even if a workspace descriptor somehow carried ws-1 with a different root, it must NOT match the old chat
      const mismatchedReuse = findMatchingProjectChat(reloaded!.chats, {
        workspaceId: "ws-1",
        workspaceRoot: canonicalNew,
        displayName: "new-ws",
      });
      expect(mismatchedReuse).toBeUndefined();

      const res = resolveMessageFileLink({
        chatId: "chat-ws-1-1",
        messageId: "m1",
        isRestoredMessage: true,
        owningBinding: reloaded!.chats[0]!.owningBinding,
        rawTarget: "README.md",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("WORKSPACE_UNAVAILABLE");
      }

      // Corrupt state file returns null cleanly
      fs.writeFileSync(store.getFilePath(), "{corrupt-json", "utf8");
      expect(store.load()).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("retains drive-root / filesystem-root workspaces and normalizes already-saved empty names on load", () => {
    expect(deriveWorkspaceDisplayName("D:\\")).toBe("D:/");
    expect(deriveWorkspaceDisplayName("c:/")).toBe("C:/");
    expect(deriveWorkspaceDisplayName("/")).toBe("/");
    expect(deriveWorkspaceDisplayName("C:\\Users\\dev\\my-repo")).toBe("my-repo");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-state-drive-root-"));
    try {
      const userDataDir = path.join(tmp, "user-data");
      const rootDir = path.parse(tmp).root; // "C:\\" on Windows, "/" on POSIX
      expect(path.basename(rootDir)).toBe("");

      const store = new DesktopStateStore(userDataDir);
      // Simulate legacy state saved with empty basename for a drive/filesystem root + an unavailable D:\ chat
      store.save({
        workspaces: [{ workspaceId: "ws-root", workspaceRoot: rootDir, displayName: "" }],
        activeWorkspaceId: "ws-root",
        activeChatId: "chat-root",
        chats: [
          {
            chatId: "chat-root",
            title: " Chat",
            owningBinding: {
              kind: "project",
              workspaceId: "ws-root",
              workspaceRoot: rootDir,
              workspaceDisplayName: "",
            },
            messages: [{ messageId: "m-root", role: "user", text: "hi root", isRestoredMessage: false }],
            composerDraft: "",
          },
          {
            chatId: "chat-win-drive",
            title: " Chat",
            owningBinding: {
              kind: "project",
              workspaceId: "ws-d-drive",
              workspaceRoot: "D:\\",
              workspaceDisplayName: "",
            },
            messages: [{ messageId: "m-d", role: "user", text: "hi D:", isRestoredMessage: false }],
            composerDraft: "",
          },
        ],
      });

      const reloaded = store.load();
      expect(reloaded).not.toBeNull();
      expect(reloaded!.workspaces).toHaveLength(1);
      expect(reloaded!.workspaces[0]!.displayName).toBe(deriveWorkspaceDisplayName(rootDir));
      expect(reloaded!.workspaces[0]!.displayName.length).toBeGreaterThan(0);

      expect(reloaded!.chats).toHaveLength(2);
      const rootChat = reloaded!.chats.find((c) => c.chatId === "chat-root")!;
      expect(rootChat.owningBinding.kind).toBe("project");
      if (rootChat.owningBinding.kind === "project") {
        expect(rootChat.owningBinding.workspaceDisplayName).toBe(deriveWorkspaceDisplayName(rootDir));
      }
      expect(rootChat.title).toBe(`${deriveWorkspaceDisplayName(rootDir)} Chat`);

      const winDriveChat = reloaded!.chats.find((c) => c.chatId === "chat-win-drive")!;
      expect(winDriveChat.owningBinding.kind).toBe("project");
      if (winDriveChat.owningBinding.kind === "project") {
        expect(winDriveChat.owningBinding.workspaceDisplayName).toBe("D:/");
      }
      expect(winDriveChat.title).toBe("D:/ Chat");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("buildAskQuestionAnswer (OMP v19.1.1 parseAskDialogResponse contract)", () => {
  it("makes single-choice write-ins mutually exclusive with preset options while allowing both for multi-select", () => {
    expect(
      buildAskQuestionAnswer({
        id: "q-single-preset",
        multi: false,
        selectedOptions: ["Staging"],
        customInput: "   ",
      }),
    ).toEqual({
      id: "q-single-preset",
      selectedOptions: ["Staging"],
    });

    expect(
      buildAskQuestionAnswer({
        id: "q-single-writein",
        multi: false,
        selectedOptions: ["Staging"],
        customInput: "smoke-check",
      }),
    ).toEqual({
      id: "q-single-writein",
      selectedOptions: [],
      customInput: "smoke-check",
    });

    expect(
      buildAskQuestionAnswer({
        id: "q-multi-both",
        multi: true,
        selectedOptions: ["Unit", "E2E"],
        customInput: "nightly",
      }),
    ).toEqual({
      id: "q-multi-both",
      selectedOptions: ["Unit", "E2E"],
      customInput: "nightly",
    });
  });
});

describe("omp-message extractors (streaming deltas & snapshots)", () => {
  it("extracts partial snapshots and incremental deltas while ignoring user/tool frames", () => {
    expect(extractAssistantText({ role: "user", text: "ignored" })).toBeNull();
    expect(extractAssistantText({ role: "toolResult", content: "ignored" })).toBeNull();

    let acc = "";
    acc = extractStreamingUpdateText({ assistantMessageEvent: { type: "text_delta", delta: "Hel" } }, acc) ?? acc;
    acc = extractStreamingUpdateText({ assistantMessageEvent: { type: "text_delta", delta: "lo!" } }, acc) ?? acc;
    expect(acc).toBe("Hello!");

    // Authoritative partial message snapshot overrides without double-appending delta
    const snap = extractStreamingUpdateText(
      {
        message: { role: "assistant", content: [{ type: "text", text: "Hello world!" }] },
        assistantMessageEvent: { type: "text_delta", delta: " world!" },
      },
      acc,
    );
    expect(snap).toBe("Hello world!");
  });
});

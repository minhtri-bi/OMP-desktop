import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeExistingPath, resolveMessageFileLink } from "../../src/main/path-resolver";
import { DesktopStateStore } from "../../src/main/state-store";
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

  it("handles deleted workspaces and corrupt state files gracefully without crashing startup", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-state-missing-ws-"));
    try {
      const wsGone = path.join(tmp, "deleted-ws");
      const userDataDir = path.join(tmp, "user-data");
      fs.mkdirSync(wsGone, { recursive: true });
      const canonicalGone = canonicalizeExistingPath(wsGone);

      const store = new DesktopStateStore(userDataDir);
      store.save({
        workspaces: [{ workspaceId: "ws-gone", workspaceRoot: canonicalGone, displayName: "deleted-ws" }],
        activeWorkspaceId: "ws-gone",
        activeChatId: "chat-gone",
        chats: [
          {
            chatId: "chat-gone",
            title: "Deleted Project Chat",
            owningBinding: {
              kind: "project",
              workspaceId: "ws-gone",
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

      const res = resolveMessageFileLink({
        chatId: "chat-gone",
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

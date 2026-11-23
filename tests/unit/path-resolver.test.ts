import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPreviewTabKey,
  canonicalizeExistingPath,
  resolveMessageFileLink,
  resolvePreviewSubresource,
  validatePathSyntax,
} from "../../src/main/path-resolver";
import type { ChatWorkspaceBinding } from "../../src/shared/contracts";

describe("path-resolver (Windows-first canonicalization & isolation)", () => {
  let tempDir: string;
  let wsA: string;
  let wsASibling: string;
  let wsB: string;
  let outsideDir: string;
  let bindingA: Extract<ChatWorkspaceBinding, { kind: "project" }>;
  let symlinkPathInA: string | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-desktop-path-test-"));
    wsA = path.join(tempDir, "workspace-a");
    wsASibling = path.join(tempDir, "workspace-a-sibling");
    wsB = path.join(tempDir, "workspace-b");
    outsideDir = path.join(tempDir, "outside-workspace");

    fs.mkdirSync(path.join(wsA, "docs"), { recursive: true });
    fs.mkdirSync(path.join(wsA, "src"), { recursive: true });
    fs.mkdirSync(path.join(wsA, "web"), { recursive: true });
    fs.mkdirSync(wsASibling, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    fs.writeFileSync(path.join(wsA, "docs", "sample.pdf"), "%PDF-1.4\n%%EOF\n");
    fs.writeFileSync(path.join(wsA, "src", "hello.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(wsA, "web", "preview.html"), "<h1>hi</h1>\n");
    fs.writeFileSync(path.join(wsASibling, "file.txt"), "PREFIX_COLLISION_SENTINEL");
    fs.writeFileSync(path.join(wsB, "notes.md"), "# Workspace B\n");
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "OUTSIDE_WORKSPACE_SENTINEL");

    // Create a symlink or Windows directory junction pointing outside workspace-a
    const fileLink = path.join(wsA, "escaped-file.txt");
    try {
      fs.symlinkSync(path.join(outsideDir, "secret.txt"), fileLink, "file");
      symlinkPathInA = "escaped-file.txt";
    } catch {
      const dirLink = path.join(wsA, "escaped-dir");
      fs.symlinkSync(outsideDir, dirLink, "junction");
      symlinkPathInA = "escaped-dir/secret.txt";
    }

    bindingA = {
      kind: "project",
      workspaceId: "ws-a",
      workspaceRoot: canonicalizeExistingPath(wsA),
      workspaceDisplayName: "workspace-a",
    };
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects dangerous Windows path syntax before touching disk", () => {
    const dangerousInputs = [
      "",
      "   ",
      "src/hello.ts\0.txt",
      "\\\\127.0.0.1\\c$\\Windows\\win.ini",
      "//server/share/file.txt",
      "\\\\?\\C:\\Windows\\win.ini",
      "\\\\.\\PhysicalDrive0",
      "file://server/share/file.txt",
      "C:relative.txt",
      "\\drive-root-relative.txt",
      "src/hello.ts:hidden:$DATA",
      "CON",
      "docs/NUL.pdf",
      "src/COM1.txt",
      "LPT9 ",
      "ms-msdt:/id",
      "cmd:/c calc",
      "javascript:alert(1)",
    ];

    for (const rawTarget of dangerousInputs) {
      const syntax = validatePathSyntax(rawTarget);
      expect(syntax.ok, `Expected unsafe syntax rejection for ${JSON.stringify(rawTarget)}`).toBe(
        false,
      );
      const res = resolveMessageFileLink({
        chatId: "chat-1",
        messageId: "msg-1",
        isRestoredMessage: true,
        owningBinding: bindingA,
        rawTarget,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("UNSAFE_PATH_SYNTAX");
      }
    }
  });

  it("resolves PDF, source, HTML, and folders within owning workspace", () => {
    const pdf = resolveMessageFileLink({
      chatId: "chat-1",
      messageId: "msg-1",
      isRestoredMessage: true,
      owningBinding: bindingA,
      rawTarget: "docs/sample.pdf",
    });
    expect(pdf.ok).toBe(true);
    if (pdf.ok) {
      expect(pdf.descriptor.viewerKind).toBe("pdf");
      expect(pdf.descriptor.parentBrowsingAllowed).toBe(true);
      expect(pdf.descriptor.breadcrumbs.map((b) => b.label)).toEqual([
        "workspace-a",
        "docs",
        "sample.pdf",
      ]);
    }

    const html = resolveMessageFileLink({
      chatId: "chat-1",
      messageId: "msg-1",
      isRestoredMessage: true,
      owningBinding: bindingA,
      rawTarget: "web/preview.html",
    });
    expect(html.ok).toBe(true);
    if (html.ok) {
      expect(html.descriptor.viewerKind).toBe("html-isolated-browser");
    }

    const htmlAsSource = resolveMessageFileLink({
      chatId: "chat-1",
      messageId: "msg-1",
      isRestoredMessage: false,
      owningBinding: bindingA,
      rawTarget: "web/preview.html",
      preferSourceView: true,
    });
    expect(htmlAsSource.ok).toBe(true);
    if (htmlAsSource.ok) {
      expect(htmlAsSource.descriptor.viewerKind).toBe("source");
    }

    const folder = resolveMessageFileLink({
      chatId: "chat-1",
      messageId: "msg-1",
      isRestoredMessage: false,
      owningBinding: bindingA,
      rawTarget: "src",
    });
    expect(folder.ok).toBe(true);
    if (folder.ok) {
      expect(folder.descriptor.viewerKind).toBe("folder-explorer");
    }
  });

  it("produces identical case-insensitive tab keys across Windows path variants", () => {
    const canonical = canonicalizeExistingPath(path.join(wsA, "src", "hello.ts"));
    const keyLower = buildPreviewTabKey(bindingA, canonical);
    const keyUpper = buildPreviewTabKey(bindingA, canonical.toUpperCase());
    const keyBackslash = buildPreviewTabKey(bindingA, canonical.replace(/\//g, "\\"));
    expect(keyLower).toBe(keyUpper);
    expect(keyLower).toBe(keyBackslash);
  });

  it("distinguishes STALE_LINK (restored) from MISSING_FILE (live)", () => {
    const stale = resolveMessageFileLink({
      chatId: "chat-1",
      messageId: "msg-1",
      isRestoredMessage: true,
      owningBinding: bindingA,
      rawTarget: "docs/deleted.pdf",
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("STALE_LINK");

    const missing = resolveMessageFileLink({
      chatId: "chat-1",
      messageId: "msg-2",
      isRestoredMessage: false,
      owningBinding: bindingA,
      rawTarget: "docs/deleted.pdf",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("MISSING_FILE");
  });

  it("blocks traversal, prefix collisions, and symlink/junction escapes outside workspace", () => {
    for (const escapeTarget of [
      "../outside-workspace/secret.txt",
      "../workspace-a-sibling/file.txt",
      path.join(wsB, "notes.md"),
      ...(symlinkPathInA ? [symlinkPathInA] : []),
    ]) {
      const res = resolveMessageFileLink({
        chatId: "chat-1",
        messageId: "msg-1",
        isRestoredMessage: true,
        owningBinding: bindingA,
        rawTarget: escapeTarget,
      });
      expect(res.ok, `Expected OUT_OF_WORKSPACE for ${escapeTarget}`).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("OUT_OF_WORKSPACE");
      }
    }
  });

  it("enforces standalone chat explicit-attachment allowlist and disables parent browsing", () => {
    const attached = canonicalizeExistingPath(path.join(wsA, "src", "hello.ts"));
    const unattached = canonicalizeExistingPath(path.join(wsB, "notes.md"));
    const standaloneBinding: ChatWorkspaceBinding = {
      kind: "standalone",
      chatId: "standalone-1",
      attachedCanonicalPaths: [attached],
    };

    const allowed = resolveMessageFileLink({
      chatId: "standalone-1",
      messageId: "m1",
      isRestoredMessage: false,
      owningBinding: standaloneBinding,
      rawTarget: attached,
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.descriptor.parentBrowsingAllowed).toBe(false);
      expect(allowed.descriptor.breadcrumbs.every((b) => b.browsableRelativePath === null)).toBe(
        true,
      );
    }

    for (const blockedTarget of [unattached, "src/hello.ts", wsA]) {
      const res = resolveMessageFileLink({
        chatId: "standalone-1",
        messageId: "m1",
        isRestoredMessage: false,
        owningBinding: standaloneBinding,
        rawTarget: blockedTarget,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("UNATTACHED_STANDALONE_PATH");
      }
    }
  });

  it("blocks preview subresource traversal and standalone sibling access with 403", () => {
    const rootA = canonicalizeExistingPath(wsA);
    const okSub = resolvePreviewSubresource(rootA, "/web/preview.html");
    expect(okSub.ok).toBe(true);

    const traversal = resolvePreviewSubresource(rootA, "/../outside-workspace/secret.txt");
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.statusCode).toBe(403);

    if (symlinkPathInA) {
      const symSub = resolvePreviewSubresource(rootA, `/${symlinkPathInA}`);
      expect(symSub.ok).toBe(false);
      if (!symSub.ok) expect(symSub.statusCode).toBe(403);
    }

    const singleFile = canonicalizeExistingPath(path.join(wsA, "web", "preview.html"));
    const siblingBlocked = resolvePreviewSubresource(path.dirname(singleFile), "/other.js", singleFile);
    expect(siblingBlocked.ok).toBe(false);
    if (!siblingBlocked.ok) expect(siblingBlocked.statusCode).toBe(403);
  });
});

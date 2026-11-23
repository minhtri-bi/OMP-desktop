import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

let tempBase: string;
let fixtureCopyRoot: string;
let userDataDir: string;
let symlinkRelativeTarget: string;
let electronApp: ElectronApplication;
let page: Page;
let probeServer: http.Server;
let probeServerPort = 0;
let probeServerHits = 0;

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

test.beforeAll(async () => {
  probeServer = http.createServer((_req, res) => {
    probeServerHits += 1;
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Access-Control-Allow-Origin": "*",
    });
    res.end("probe-ok");
  });
  await new Promise<void>((resolve) => {
    probeServer.listen(0, "127.0.0.1", () => {
      const addr = probeServer.address();
      if (addr && typeof addr === "object") {
        probeServerPort = addr.port;
      }
      resolve();
    });
  });

  tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "omp-desktop-e2e-"));
  fixtureCopyRoot = path.join(tempBase, "fixtures");
  userDataDir = path.join(tempBase, "user-data");
  fs.mkdirSync(userDataDir, { recursive: true });

  const sourceFixtures = path.resolve(process.cwd(), "tests", "fixtures");
  copyDirRecursive(sourceFixtures, fixtureCopyRoot);

  // Dynamically create a symlink (or Windows directory junction) inside workspace-a pointing outside workspace-a
  const wsA = path.join(fixtureCopyRoot, "workspace-a");
  const outsideDir = path.join(fixtureCopyRoot, "outside-workspace");
  fs.writeFileSync(path.join(wsA, "docs", "corrupt.pdf"), "NOT_A_VALID_PDF_HEADER\n", "utf8");
  try {
    fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(wsA, "escaped-link.txt"), "file");
    symlinkRelativeTarget = "escaped-link.txt";
  } catch {
    fs.symlinkSync(outsideDir, path.join(wsA, "escaped-dir"), "junction");
    symlinkRelativeTarget = "escaped-dir/secret.txt";
  }

  const launchArgs = [path.resolve(process.cwd())];
  if (process.platform === "linux") {
    launchArgs.push("--no-sandbox", "--disable-gpu-sandbox");
  }

  electronApp = await electron.launch({
    args: launchArgs,
    env: {
      ...process.env,
      OMP_DESKTOP_FIXTURE_ROOT: fixtureCopyRoot,
      OMP_DESKTOP_USER_DATA: userDataDir,
      OMP_DESKTOP_TEST_SYMLINK_LINK: symlinkRelativeTarget,
    },
  });

  page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("active-chat-title")).toHaveText("Restored Workspace A Chat");
});

test.afterAll(async () => {
  if (electronApp) {
    await electronApp.close();
  }
  if (probeServer) {
    await new Promise<void>((resolve) => probeServer.close(() => resolve()));
  }
  if (tempBase && fs.existsSync(tempBase)) {
    fs.rmSync(tempBase, { recursive: true, force: true });
  }
});

test("ACC-01..ACC-08: real click-to-preview journey, project switching, standalone scope, and security boundaries", async () => {
  // ACC-01: Click real PDF link in restored chat -> renders beside chat with page navigation and zoom
  await page.getByTestId("chat-link-link-pdf").click();
  await expect(page.getByTestId("pdf-viewer")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 / 2");
  await expect(page.getByTestId("pdf-zoom-indicator")).toHaveText("100%");
  await expect(page.getByTestId("breadcrumb-browsable-0")).toHaveText("workspace-a");

  const initialCanvasWidth = await page
    .getByTestId("pdf-canvas")
    .evaluate((el) => (el as HTMLCanvasElement).width);
  expect(initialCanvasWidth).toBeGreaterThan(100);

  await page.getByTestId("pdf-next-page").click();
  await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 / 2");

  await page.getByTestId("pdf-zoom-in").click();
  await expect(page.getByTestId("pdf-zoom-indicator")).toHaveText("125%");
  const zoomedCanvasWidth = await page
    .getByTestId("pdf-canvas")
    .evaluate((el) => (el as HTMLCanvasElement).width);
  expect(zoomedCanvasWidth).toBeGreaterThan(initialCanvasWidth);

  // Regression: opening and closing breadcrumb popover on a PDF tab keeps current page and zoom
  await page.getByTestId("breadcrumb-browsable-0").click();
  await expect(page.getByTestId("breadcrumb-siblings")).toBeVisible();
  await page.getByTestId("breadcrumb-browsable-0").click();
  await expect(page.getByTestId("breadcrumb-siblings")).toBeHidden();
  await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 / 2");
  await expect(page.getByTestId("pdf-zoom-indicator")).toHaveText("125%");

  // ACC-02: Click source link with line range + case-insensitive second click focuses same tab without duplicate
  await page.getByTestId("chat-link-link-source").click();
  await expect(page.getByTestId("source-viewer")).toBeVisible();
  await expect(page.getByTestId("source-viewer")).toContainText("WORKSPACE_A_HELLO_TS");
  await expect(page.locator(".source-line.highlighted")).toHaveCount(6); // lines 5..10 inclusive

  const tabsAfterSource = await page.getByTestId("preview-tab-item").count();
  expect(tabsAfterSource).toBe(2);

  await page.getByTestId("chat-link-link-source-case-variant").click();
  await expect(page.getByTestId("preview-tab-item")).toHaveCount(2);

  // ACC-03: Click HTML link -> opens interactive page in isolated Electron WebContentsView (NOT raw source text)
  await page.getByTestId("chat-link-link-html").click();
  await expect(page.getByTestId("isolated-view-host")).toBeVisible();
  await expect(page.getByTestId("isolated-view-host")).toHaveAttribute("data-view-ready", "true");
  await expect(page.getByTestId("source-viewer")).toBeHidden();
  await expect(page.getByTestId("html-preview-origin")).toContainText("omp-preview://");
  await expect(page.getByTestId("html-network-toggle")).toHaveText("External Network: Blocked");

  // Inspect the REAL isolated Electron WebContentsView inside the main process
  const probeUrl = `http://127.0.0.1:${probeServerPort}/probe`;
  const isolatedHtmlCheck = await electronApp.evaluate(async ({ BrowserWindow }, targetProbeUrl) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No BrowserWindow");
    const children = win.contentView.children as Array<{ webContents?: Electron.WebContents }>;
    const previewView = children.find((c) => c.webContents?.getURL().startsWith("omp-preview://"));
    if (!previewView?.webContents) {
      throw new Error("Expected isolated omp-preview WebContentsView");
    }
    const wc = previewView.webContents;
    await wc.executeJavaScript(`
      new Promise((resolve) => {
        if (document.readyState === 'complete') resolve(true);
        else window.addEventListener('load', () => resolve(true), { once: true });
      })
    `);
    const before = await wc.executeJavaScript(`({
      origin: document.getElementById('probe-origin')?.textContent,
      ompDesktop: document.getElementById('probe-omp-desktop')?.textContent,
      ipc: document.getElementById('probe-ipc')?.textContent,
      tauri: document.getElementById('probe-tauri')?.textContent,
      counterBefore: document.getElementById('counter-value')?.textContent,
    })`);
    await wc.executeJavaScript(`document.getElementById('increment-btn')?.click()`);
    const counterAfter = await wc.executeJavaScript(
      `document.getElementById('counter-value')?.textContent`,
    );
    const blockedFetch = await wc.executeJavaScript(
      `fetch(${JSON.stringify(targetProbeUrl)}).then(() => 'allowed', () => 'blocked')`,
    );
    return { ...before, counterAfter, blockedFetch, url: wc.getURL() };
  }, probeUrl);

  expect(isolatedHtmlCheck.url.startsWith("omp-preview://")).toBe(true);
  expect(isolatedHtmlCheck.origin.startsWith("omp-preview://")).toBe(true);
  expect(isolatedHtmlCheck.ompDesktop).toBe("undefined");
  expect(isolatedHtmlCheck.ipc).toBe("undefined");
  expect(isolatedHtmlCheck.tauri).toBe("undefined");
  expect(isolatedHtmlCheck.counterBefore).toBe("0");
  expect(isolatedHtmlCheck.counterAfter).toBe("1");
  expect(isolatedHtmlCheck.blockedFetch).toBe("blocked");
  expect(probeServerHits).toBe(0);

  // Verify per-tab opt-in external network toggle enables HTTP fetch cleanly
  await page.getByTestId("html-network-toggle").click();
  await expect(page.getByTestId("html-network-toggle")).toHaveText("External Network: Allowed");

  const allowedFetch = await electronApp.evaluate(async ({ BrowserWindow }, targetProbeUrl) => {
    const win = BrowserWindow.getAllWindows()[0];
    const children = (win?.contentView.children ?? []) as Array<{ webContents?: Electron.WebContents }>;
    const previewView = children.find((c) => c.webContents?.getURL().startsWith("omp-preview://"));
    if (!previewView?.webContents) throw new Error("Missing preview view");
    const fetchResult = await previewView.webContents.executeJavaScript(
      `fetch(${JSON.stringify(targetProbeUrl)}).then((r) => r.text(), () => 'blocked')`,
    );
    const notifPerm = await previewView.webContents.executeJavaScript(
      `typeof Notification !== 'undefined' ? Notification.requestPermission() : 'denied'`,
    );
    return { fetchResult, notifPerm };
  }, probeUrl);
  expect(allowedFetch.fetchResult).toBe("probe-ok");
  expect(allowedFetch.notifPerm).toBe("denied");
  expect(probeServerHits).toBe(1);

  // Regression: opening and closing breadcrumb popover on an HTML preview restores the isolated WebContentsView
  await page.getByTestId("breadcrumb-browsable-0").click();
  await expect(page.getByTestId("breadcrumb-siblings")).toBeVisible();
  await page.getByTestId("breadcrumb-browsable-0").click();
  await expect(page.getByTestId("breadcrumb-siblings")).toBeHidden();
  await expect(page.getByTestId("isolated-view-host")).toHaveAttribute("data-view-ready", "true");
  const htmlViewVisibleAfterBreadcrumb = await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const children = (win?.contentView.children ?? []) as Array<{
      webContents?: Electron.WebContents;
      getVisible?: () => boolean;
      getBounds?: () => { width: number; height: number };
    }>;
    const previewView = children.find((c) => c.webContents?.getURL().startsWith("omp-preview://"));
    return {
      visible: previewView?.getVisible?.() ?? false,
      width: previewView?.getBounds?.().width ?? 0,
    };
  });
  expect(htmlViewVisibleAfterBreadcrumb.visible).toBe(true);
  expect(htmlViewVisibleAfterBreadcrumb.width).toBeGreaterThan(100);

  // Regression: opening a corrupt PDF after a valid PDF clears the previous canvas and reports PDF_LOAD_ERROR
  await page.getByTestId("tree-entry-docs/corrupt.pdf").click();
  await expect(page.getByTestId("link-error-code")).toHaveText("PDF_LOAD_ERROR");
  await expect(page.getByTestId("pdf-viewer")).toBeHidden();
  const corruptCanvasWidth = await page
    .getByTestId("pdf-canvas")
    .evaluate((el) => (el as HTMLCanvasElement).width);
  expect(corruptCanvasWidth).toBe(0);

  // ACC-04: Switch visible project sidebar to Workspace B -> restored Workspace A chat links STILL resolve to Workspace A
  await page.getByTestId("workspace-item-ws-fixture-b").click();
  await expect(page.getByTestId("explorer-heading")).toHaveText("Explorer · workspace-b");
  await expect(page.getByTestId("active-chat-scope")).toHaveText("Workspace: workspace-a");

  await page.getByTestId("chat-link-link-source").click();
  await expect(page.getByTestId("source-viewer")).toContainText("WORKSPACE_A_HELLO_TS");
  await expect(page.getByTestId("source-viewer")).not.toContainText("WORKSPACE_B_MARKER");

  // Regression: creating a project chat for Workspace B binds to Workspace B without mutating Workspace A's chat
  const createdWsBChat = await page.evaluate(() => window.ompDesktop.createProjectChat("ws-fixture-b"));
  expect(createdWsBChat?.owningBinding.kind).toBe("project");
  if (createdWsBChat?.owningBinding.kind === "project") {
    expect(createdWsBChat.owningBinding.workspaceId).toBe("ws-fixture-b");
  }
  await expect(page.getByTestId("active-chat-scope")).toHaveText("Workspace: workspace-a");

  // ACC-06 & ACC-07: Stale link, traversal, prefix collision, symlink/junction escape, UNC, ADS, reserved DOS name
  const tabCountBeforeBadLinks = await page.getByTestId("preview-tab-item").count();

  await page.getByTestId("chat-link-link-stale").click();
  await expect(page.getByTestId("link-error-banner")).toBeVisible();
  await expect(page.getByTestId("link-error-code")).toHaveText("STALE_LINK");
  await expect(page.getByTestId("preview-tab-item")).toHaveCount(tabCountBeforeBadLinks);

  for (const [linkTestId, expectedCode] of [
    ["chat-link-link-traversal", "OUT_OF_WORKSPACE"],
    ["chat-link-link-prefix-collision", "OUT_OF_WORKSPACE"],
    ["chat-link-link-symlink-escape", "OUT_OF_WORKSPACE"],
    ["chat-link-link-unc", "UNSAFE_PATH_SYNTAX"],
    ["chat-link-link-ads", "UNSAFE_PATH_SYNTAX"],
    ["chat-link-link-reserved-dos", "UNSAFE_PATH_SYNTAX"],
  ] as const) {
    await page.getByTestId(linkTestId).click();
    await expect(page.getByTestId("link-error-code")).toHaveText(expectedCode);
    await expect(page.getByTestId("preview-tab-item")).toHaveCount(tabCountBeforeBadLinks);
  }

  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain("OUTSIDE_WORKSPACE_SENTINEL_DO_NOT_OPEN");
  expect(bodyText).not.toContain("PREFIX_COLLISION_SENTINEL_DO_NOT_OPEN");

  // ACC-05: Switch to Standalone chat -> preserves independent context & draft, opens attached file without parent browsing, rejects unattached path
  await page.getByTestId("chat-item-chat-standalone-default").click();
  await expect(page.getByTestId("active-chat-scope")).toHaveText("Standalone (no project folder)");
  await page.getByTestId("composer-input").fill("Summarize this attached file");
  await expect(page.getByTestId("composer-input")).toHaveValue("Summarize this attached file");

  await page.getByTestId("chat-link-standalone-attached-link").click();
  await expect(page.getByTestId("source-viewer")).toBeVisible();
  await expect(page.getByTestId("source-viewer")).toContainText("WORKSPACE_A_HELLO_TS");
  await expect(page.getByTestId("breadcrumb-static-0")).toHaveText("Attached");
  await expect(page.locator('[data-testid^="breadcrumb-browsable-"]')).toHaveCount(0);

  const tabsBeforeUnattached = await page.getByTestId("preview-tab-item").count();
  await page.getByTestId("chat-link-standalone-unattached-link").click();
  await expect(page.getByTestId("link-error-code")).toHaveText("UNATTACHED_STANDALONE_PATH");
  await expect(page.getByTestId("preview-tab-item")).toHaveCount(tabsBeforeUnattached);

  // Return to Workspace A chat and back to Standalone to verify draft and bindings remain intact
  await page.getByTestId("chat-item-chat-restored-workspace-a-001").click();
  await expect(page.getByTestId("active-chat-scope")).toHaveText("Workspace: workspace-a");
  await page.getByTestId("chat-item-chat-standalone-default").click();
  await expect(page.getByTestId("composer-input")).toHaveValue("Summarize this attached file");
  await page.getByTestId("chat-item-chat-restored-workspace-a-001").click();

  // ACC-08: Verify previewing files never triggered any prompt or implicit attachment to OMP
  const diagnostics = await page.evaluate(() => window.ompDesktop.getDiagnostics());
  expect(diagnostics.promptRequestCount).toBe(0);
  expect(diagnostics.attachmentUploadCount).toBe(0);
});

test("Open Folder creates a bound project chat and displays OMP replies via onOmpEvent", async () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-desktop-e2e-omp-"));
  const openedFolder = path.join(stubDir, "opened-project");
  const stubUserData = path.join(stubDir, "user-data");
  fs.mkdirSync(openedFolder, { recursive: true });
  fs.mkdirSync(stubUserData, { recursive: true });
  fs.writeFileSync(path.join(openedFolder, "README.md"), "# Opened Project\n", "utf8");

  const mockOmpScript = path.join(stubDir, "mock-omp.cjs");
  fs.writeFileSync(
    mockOmpScript,
    `
const readline = require("node:readline");
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
  supportsBashExcludeFromContext: true,
});
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "negotiate_protocol") {
    send({ id: msg.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
  } else if (msg.type === "prompt") {
    send({ id: msg.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
    send({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Reply from OMP in " + process.cwd() + ": " + msg.message }],
      },
    });
    send({ type: "prompt_result", id: msg.id, agentInvoked: true, status: "completed", sessionSettled: true });
  }
});
rl.on("close", () => process.exit(0));
`,
    "utf8",
  );

  const launchArgs = [path.resolve(process.cwd())];
  if (process.platform === "linux") {
    launchArgs.push("--no-sandbox", "--disable-gpu-sandbox");
  }

  const app2 = await electron.launch({
    args: launchArgs,
    env: {
      ...process.env,
      OMP_DESKTOP_FIXTURE_ROOT: fixtureCopyRoot,
      OMP_DESKTOP_USER_DATA: stubUserData,
      OMP_DESKTOP_OMP_PATH: process.execPath,
      OMP_DESKTOP_OMP_ARGS_PREFIX: JSON.stringify([mockOmpScript]),
    },
  });

  try {
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState("domcontentloaded");

    // Stub Electron's native openDirectory dialog to return openedFolder deterministically
    await app2.evaluate(({ dialog }, targetDir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [targetDir] });
    }, openedFolder);

    await win2.getByTestId("open-folder-btn").click();
    await expect(win2.getByTestId("active-chat-scope")).toHaveText("Workspace: opened-project");
    await expect(win2.getByTestId("explorer-heading")).toHaveText("Explorer · opened-project");

    await win2.getByTestId("composer-input").fill("ping-new-folder");
    await win2.getByTestId("composer-send-btn").click();

    await expect(win2.getByTestId("chat-transcript")).toContainText("Reply from OMP in");
    await expect(win2.getByTestId("chat-transcript")).toContainText("opened-project");
    await expect(win2.getByTestId("chat-transcript")).toContainText("ping-new-folder");
  } finally {
    await app2.close();
    fs.rmSync(stubDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

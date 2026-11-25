import { spawn } from "node:child_process";
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
  fs.mkdirSync(path.join(openedFolder, "docs"), { recursive: true });
  fs.mkdirSync(stubUserData, { recursive: true });
  fs.writeFileSync(
    path.join(openedFolder, "README.md"),
    "# Opened Project\nLine 2 highlighted target\nLine 3 highlighted target\nLine 4 tail\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(openedFolder, "docs", "User Guide.md"),
    "# User Guide\nSpaced file line 2 target\nLine 3\n",
    "utf8",
  );

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
        content: [
          {
            type: "text",
            text: "Reply from OMP in " + process.cwd() + ": " + msg.message +
              " — inspect [readme-lines](README.md#L2-L3), [user-guide](docs/User%20Guide.md#L2), and [README.md](https://evil.example/phish).",
          },
        ],
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

    // Verify Markdown file link inside the live reply became a clickable chip with preserved line anchor
    const replyChip = win2.getByRole("button", { name: "readme-lines" });
    await expect(replyChip).toBeVisible();
    await expect(replyChip).toHaveAttribute("title", "README.md#L2-L3");
    await replyChip.click();

    await expect(win2.getByTestId("source-viewer")).toBeVisible();
    await expect(win2.getByTestId("source-viewer")).toContainText("Line 2 highlighted target");
    await expect(win2.locator('.source-line[data-line="2"]')).toHaveClass(/highlighted/);
    await expect(win2.locator('.source-line[data-line="3"]')).toHaveClass(/highlighted/);
    await expect(win2.locator(".source-line.highlighted")).toHaveCount(2);

    // Verify percent-encoded spaced Markdown link resolves to the real spaced file and highlights line 2
    const spacedChip = win2.getByRole("button", { name: "user-guide" });
    await expect(spacedChip).toHaveAttribute("title", "docs/User Guide.md#L2");
    await spacedChip.click();
    await expect(win2.getByTestId("source-viewer")).toContainText("Spaced file line 2 target");
    await expect(win2.locator('.source-line[data-line="2"]')).toHaveClass(/highlighted/);

    // Verify external web link labeled as a filename is visually distinguished as an external URL chip
    const externalChip = win2.locator('button.external-url-chip[data-link-kind="external-url"]');
    await expect(externalChip).toHaveCount(1);
    await expect(externalChip).toContainText("WEB");
    await expect(externalChip).toContainText("evil.example");
    await expect(externalChip).toHaveAttribute(
      "title",
      "External URL (evil.example): https://evil.example/phish",
    );
  } finally {
    await app2.close();
    fs.rmSync(stubDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("Stage 2: NO_CONFIGURED_MODEL onboarding, startup dialogs, local commands, streaming/approvals/ask validation, abort, session resume, and single-instance lock", async () => {
  const stage2Dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-desktop-e2e-stage2-"));
  const unconfUserData = path.join(stage2Dir, "userdata-unconf");
  const persistUserData = path.join(stage2Dir, "userdata-persist");
  fs.mkdirSync(unconfUserData, { recursive: true });
  fs.mkdirSync(persistUserData, { recursive: true });

  const unconfMockOmp = path.join(stage2Dir, "mock-omp-unconf.cjs");
  fs.writeFileSync(
    unconfMockOmp,
    `process.stderr.write("No default model selected. Run omp /login\\n"); process.exit(1);\n`,
    "utf8",
  );

  const receivedPromptsFile = path.join(stage2Dir, "received-prompts.jsonl");
  const interactiveMockOmp = path.join(stage2Dir, "mock-omp-interactive.cjs");
  fs.writeFileSync(
    interactiveMockOmp,
    `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const receivedPromptsFile = ${JSON.stringify(receivedPromptsFile)};

const argv = process.argv.slice(2);
const dirIdx = argv.indexOf("--session-dir");
const sessionDir = dirIdx !== -1 ? argv[dirIdx + 1] : null;
const hasContinue = argv.includes("--continue");
const sessionFile = sessionDir ? path.join(sessionDir, "session-history.json") : null;

// Mirror OMP v19.1.1: --session-dir alone starts fresh; only --continue resumes saved runtime context
let history = [];
if (sessionFile && hasContinue && fs.existsSync(sessionFile)) {
  history = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
}
const saveHistory = () => {
  if (sessionFile) {
    fs.writeFileSync(sessionFile, JSON.stringify(history), "utf8");
  }
};

// Emit ready before extension session_start confirmation (exact OMP v19.1.1 ordering)
send({
  type: "ready",
  version: "19.1.1",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
  supportsBashExcludeFromContext: true,
});

let startupApproved = history.length > 0;
let queuedNegotiate = null;
if (!startupApproved) {
  send({
    type: "extension_ui_request",
    id: "startup-confirm-1",
    method: "confirm",
    title: "Initialize workspace extension",
    message: "Approve session_start hook before negotiation",
  });
}

let confirmResult = null;
let secretLen = 0;

const askQuestions = [
  {
    id: "q-env",
    header: "Environment",
    question: "Which target should OMP verify?",
    options: [
      { label: "Staging", description: "Safe pre-prod check" },
      { label: "Production", description: "Live check" },
    ],
    recommended: 0,
  },
  {
    id: "q-suites",
    header: "Checks",
    question: "Which checks should run?",
    options: [
      { label: "Unit", description: "Fast unit tests" },
      { label: "E2E", description: "Electron acceptance" },
    ],
    multi: true,
  },
];

// Mirror pinned OMP v19.1.1 parseAskDialogResponse validation
function validateAskAnswers(answers) {
  if (!Array.isArray(answers) || answers.length !== askQuestions.length) {
    throw new Error("Ask response answer count mismatch");
  }
  return askQuestions.map((q, idx) => {
    const ans = answers[idx];
    if (!ans || ans.id !== q.id) throw new Error("Ask answer id mismatch");
    const labels = q.options.map((o) => o.label);
    const multi = q.multi === true;
    const selected = Array.isArray(ans.selectedOptions) ? ans.selectedOptions : null;
    if (!selected) throw new Error("selectedOptions must be an array");
    for (const label of selected) {
      if (!labels.includes(label)) throw new Error("Unknown option label: " + label);
    }
    const custom = typeof ans.customInput === "string" ? ans.customInput.trim() || undefined : undefined;
    if (!multi && (selected.length > 1 || (selected.length > 0 && custom !== undefined))) {
      throw new Error("Single-select question " + q.id + " cannot carry both selectedOptions and customInput");
    }
    return { id: q.id, selectedOptions: selected, customInput: custom };
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    fs.appendFileSync(receivedPromptsFile, JSON.stringify(msg.message) + "\\n", "utf8");
  }
  if (msg.type === "extension_ui_response" && msg.id === "startup-confirm-1") {
    startupApproved = msg.confirmed === true;
    if (queuedNegotiate) {
      send({
        id: queuedNegotiate.id,
        type: "response",
        command: "negotiate_protocol",
        success: startupApproved,
        data: { protocolVersion: 2 },
      });
      queuedNegotiate = null;
    }
  } else if (msg.type === "negotiate_protocol") {
    if (startupApproved) {
      send({ id: msg.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    } else {
      queuedNegotiate = msg;
    }
  } else if (msg.type === "set_ask_dialog") {
    send({ id: msg.id, type: "response", command: "set_ask_dialog", success: true });
  } else if (msg.type === "prompt" && msg.message === "/session info") {
    // Local command ack: explicit agentInvoked: false and NO prompt_result
    send({ id: msg.id, type: "response", command: "prompt", success: true, data: { agentInvoked: false } });
  } else if (msg.type === "prompt" && msg.message === "test-approvals-and-stream") {
    // Regular prompt ack omits data entirely (matching OMP v19.1.1)
    history.push({ role: "user", text: "codename=Falcon:" + msg.message });
    saveHistory();
    send({ id: msg.id, type: "response", command: "prompt", success: true });
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Checking " } });
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "permissions..." } });
    send({
      type: "extension_ui_request",
      id: "confirm-1",
      method: "confirm",
      title: "Approve write tool",
      message: "Write settings to config.json",
    });
  } else if (msg.type === "extension_ui_response" && msg.id === "confirm-1") {
    confirmResult = msg.confirmed;
    send({
      type: "extension_ui_request",
      id: "secret-1",
      method: "input",
      title: "Enter API secret",
      placeholder: "sk-...",
      secret: true,
    });
  } else if (msg.type === "extension_ui_response" && msg.id === "secret-1") {
    secretLen = typeof msg.value === "string" ? msg.value.length : -1;
    send({
      type: "extension_ui_request",
      id: "ask-1",
      method: "ask",
      questions: askQuestions,
    });
  } else if (msg.type === "extension_ui_response" && msg.id === "ask-1") {
    let summary;
    try {
      const validated = validateAskAnswers(msg.answers);
      const q1 = validated[0];
      const q2 = validated[1];
      summary =
        "Completed turn: confirmed=" +
        String(confirmResult) +
        ", secretLen=" +
        String(secretLen) +
        ", q1Selected=" +
        (q1.selectedOptions.length > 0 ? q1.selectedOptions.join("+") : "empty") +
        ", q1Custom=" +
        (q1.customInput || "none") +
        ", q2Selected=" +
        (q2.selectedOptions.length > 0 ? q2.selectedOptions.join("+") : "empty") +
        ", q2Custom=" +
        (q2.customInput || "none");
    } catch (err) {
      summary = "ASK_VALIDATION_ERROR: " + String(err.message || err);
    }
    history.push({ role: "assistant", text: summary });
    saveHistory();
    send({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: summary }] },
    });
    send({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
  } else if (msg.type === "prompt" && msg.message === "test-abort-stream") {
    send({ id: msg.id, type: "response", command: "prompt", success: true });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Streaming step before abort" },
    });
  } else if (msg.type === "prompt" && msg.message === "recall-context") {
    send({ id: msg.id, type: "response", command: "prompt", success: true });
    const hasFalcon = history.some((entry) => String(entry.text || "").includes("codename=Falcon"));
    const reply =
      "Resumed runtime context: historyLen=" +
      String(history.length) +
      ", sawFalcon=" +
      String(hasFalcon);
    history.push({ role: "user", text: msg.message });
    history.push({ role: "assistant", text: reply });
    saveHistory();
    send({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: reply }] },
    });
    send({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
  } else if (msg.type === "abort") {
    send({ id: msg.id, type: "response", command: "abort", success: true });
    send({ type: "prompt_result", agentInvoked: true, status: "aborted", sessionSettled: true });
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

  try {
    // 1. Verify NO_CONFIGURED_MODEL onboarding card when OMP has zero configured models
    const appUnconf = await electron.launch({
      args: launchArgs,
      env: {
        ...process.env,
        OMP_DESKTOP_FIXTURE_ROOT: fixtureCopyRoot,
        OMP_DESKTOP_USER_DATA: unconfUserData,
        OMP_DESKTOP_OMP_PATH: process.execPath,
        OMP_DESKTOP_OMP_ARGS_PREFIX: JSON.stringify([unconfMockOmp]),
      },
    });
    try {
      const winUnconf = await appUnconf.firstWindow();
      await winUnconf.waitForLoadState("domcontentloaded");
      await winUnconf.getByTestId("composer-input").fill("hello unconfigured omp");
      await winUnconf.getByTestId("composer-send-btn").click();

      await expect(winUnconf.getByTestId("onboarding-card")).toBeVisible();
      await expect(winUnconf.getByTestId("onboarding-card")).toContainText("NO_CONFIGURED_MODEL");
      await expect(winUnconf.getByTestId("onboarding-card")).toContainText("/login");
    } finally {
      await appUnconf.close();
    }

    // 2. Verify startup session_start dialog, local command (agentInvoked: false), streaming,
    //    confirm/secret/ask validation, abort button, and draft/chat persistence
    const appLive = await electron.launch({
      args: launchArgs,
      env: {
        ...process.env,
        OMP_DESKTOP_FIXTURE_ROOT: fixtureCopyRoot,
        OMP_DESKTOP_USER_DATA: persistUserData,
        OMP_DESKTOP_OMP_PATH: process.execPath,
        OMP_DESKTOP_OMP_ARGS_PREFIX: JSON.stringify([interactiveMockOmp]),
      },
    });
    try {
      const winLive = await appLive.firstWindow();
      await winLive.waitForLoadState("domcontentloaded");

      // 2a. Verify Stop pressed during startup approval cancels the pending submission cleanly
      //     (disposes starting adapter, clears startup dialog, never dispatches the cancelled prompt!)
      await winLive.getByTestId("composer-input").fill("cancelled-before-ready-prompt");
      await winLive.getByTestId("composer-send-btn").click();
      await expect(winLive.getByTestId("dialog-card-startup-confirm-1")).toBeVisible();
      await expect(winLive.getByTestId("composer-abort-btn")).toBeVisible();
      await winLive.getByTestId("composer-abort-btn").click();

      await expect(winLive.getByTestId("dialog-card-startup-confirm-1")).toHaveCount(0);
      await expect(winLive.getByTestId("composer-abort-btn")).toBeHidden();
      await expect(winLive.getByTestId("composer-send-btn")).toBeEnabled();
      await expect(winLive.getByTestId("chat-transcript")).toContainText("Turn aborted.");

      // 2b. Send a local command `/session info` -> triggers startup `session_start` confirm dialog!
      await winLive.getByTestId("composer-input").fill("/session info");
      await winLive.getByTestId("composer-send-btn").click();

      // Startup dialog must be answerable BEFORE protocol negotiation completes!
      await expect(winLive.getByTestId("dialog-card-startup-confirm-1")).toBeVisible();
      await winLive.getByTestId("dialog-approve-btn").click();
      await expect(winLive.getByTestId("dialog-card-startup-confirm-1")).toHaveCount(0);

      // Local command finishes with agentInvoked: false -> composer MUST unlock (no Stop lockout!)
      await expect(winLive.getByTestId("composer-abort-btn")).toBeHidden();
      await expect(winLive.getByTestId("composer-send-btn")).toBeEnabled();

      // Confirm at the runtime layer that the startup-aborted prompt was NEVER dispatched to OMP
      const dispatchedPrompts = fs
        .readFileSync(receivedPromptsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string);
      expect(dispatchedPrompts).not.toContain("cancelled-before-ready-prompt");
      expect(dispatchedPrompts).toContain("/session info");

      // Now send a full streaming + approval + secret + ask prompt
      await winLive.getByTestId("composer-input").fill("test-approvals-and-stream");
      await winLive.getByTestId("composer-send-btn").click();

      // Streaming card & Abort button appear while confirm approval card waits for user decision
      await expect(winLive.getByTestId("streaming-message-text")).toHaveText("Checking permissions...");
      await expect(winLive.getByTestId("composer-abort-btn")).toBeVisible();
      await expect(winLive.getByTestId("dialog-card-confirm-1")).toBeVisible();
      await expect(winLive.getByTestId("dialog-confirm-message")).toHaveText(
        "Write settings to config.json",
      );
      await winLive.getByTestId("dialog-approve-btn").click();

      // Secret input dialog masks input (`type="password"`) and never echoes secret to transcript
      await expect(winLive.getByTestId("dialog-card-secret-1")).toBeVisible();
      const secretInput = winLive.getByTestId("dialog-secret-input");
      await expect(secretInput).toHaveAttribute("type", "password");
      await secretInput.fill("s3cr3t-tok");
      await winLive.getByTestId("dialog-submit-btn").click();

      // Structured ask dialog:
      // - Typing then clearing single-choice write-in restores preset Staging automatically
      // - Single-choice q-env write-in automatically unchecks preset Staging & checks Other (mutually exclusive!)
      // - Multi-select q-suites allows BOTH checking Unit AND writing "nightly"
      // - Switching to another chat and back preserves in-progress dialog inputs & selections!
      await expect(winLive.getByTestId("dialog-card-ask-1")).toBeVisible();
      await winLive.getByTestId("dialog-ask-custom-q-env").fill("temporary-draft");
      await expect(winLive.getByTestId("dialog-ask-other-q-env")).toBeChecked();
      await winLive.getByTestId("dialog-ask-custom-q-env").fill("");
      await expect(winLive.getByTestId("dialog-ask-opt-q-env-0")).toBeChecked();

      await winLive.getByTestId("dialog-ask-custom-q-env").fill("smoke-check");
      await expect(winLive.getByTestId("dialog-ask-opt-q-env-0")).not.toBeChecked();
      await expect(winLive.getByTestId("dialog-ask-other-q-env")).toBeChecked();
      await winLive.getByTestId("dialog-ask-opt-q-suites-0").check();
      await winLive.getByTestId("dialog-ask-custom-q-suites").fill("nightly");

      // Switch to Standalone chat and back -> pending dialog answers must survive intact
      await winLive.getByTestId("chat-item-chat-standalone-default").click();
      await expect(winLive.getByTestId("dialog-card-ask-1")).toBeHidden();
      await winLive.getByTestId("chat-item-chat-restored-workspace-a-001").click();
      await expect(winLive.getByTestId("dialog-card-ask-1")).toBeVisible();
      await expect(winLive.getByTestId("dialog-ask-custom-q-env")).toHaveValue("smoke-check");
      await expect(winLive.getByTestId("dialog-ask-opt-q-suites-0")).toBeChecked();
      await expect(winLive.getByTestId("dialog-ask-custom-q-suites")).toHaveValue("nightly");

      await winLive.getByTestId("dialog-submit-btn").click();

      await expect(winLive.getByTestId("chat-transcript")).toContainText(
        "Completed turn: confirmed=true, secretLen=10, q1Selected=empty, q1Custom=smoke-check, q2Selected=Unit, q2Custom=nightly",
      );
      await expect(winLive.getByTestId("chat-transcript")).not.toContainText("ASK_VALIDATION_ERROR");
      await expect(winLive.getByTestId("chat-transcript")).not.toContainText("s3cr3t-tok");
      await expect(winLive.getByTestId("composer-abort-btn")).toBeHidden();

      // Test mid-stream Abort button
      await winLive.getByTestId("composer-input").fill("test-abort-stream");
      await winLive.getByTestId("composer-send-btn").click();
      await expect(winLive.getByTestId("streaming-message-text")).toHaveText(
        "Streaming step before abort",
      );
      await winLive.getByTestId("composer-abort-btn").click();

      await expect(winLive.getByTestId("chat-transcript")).toContainText("Streaming step before abort");
      await expect(winLive.getByTestId("chat-transcript")).toContainText("[Turn aborted]");
      await expect(winLive.getByTestId("composer-abort-btn")).toBeHidden();

      // Type unsent draft and wait for debounced state sync before closing app
      await winLive.getByTestId("composer-input").fill("persisted-draft-across-restart");
      await winLive.waitForTimeout(300);
    } finally {
      await appLive.close();
    }

    // 3. Relaunch Electron with the SAME userData directory and confirm:
    //    - desktop transcript & draft restored
    //    - relaunched OMP runtime ACTUALLY resumed session history (--session-dir + --continue)
    //    - launching a second Electron instance with the same userData exits cleanly without overwriting state
    const appRestarted = await electron.launch({
      args: launchArgs,
      env: {
        ...process.env,
        OMP_DESKTOP_FIXTURE_ROOT: fixtureCopyRoot,
        OMP_DESKTOP_USER_DATA: persistUserData,
        OMP_DESKTOP_OMP_PATH: process.execPath,
        OMP_DESKTOP_OMP_ARGS_PREFIX: JSON.stringify([interactiveMockOmp]),
      },
    });
    try {
      const winRestarted = await appRestarted.firstWindow();
      await winRestarted.waitForLoadState("domcontentloaded");

      await expect(winRestarted.getByTestId("chat-transcript")).toContainText(
        "Completed turn: confirmed=true, secretLen=10, q1Selected=empty, q1Custom=smoke-check, q2Selected=Unit, q2Custom=nightly",
      );
      await expect(winRestarted.getByTestId("chat-transcript")).toContainText("[Turn aborted]");
      await expect(winRestarted.getByTestId("composer-input")).toHaveValue(
        "persisted-draft-across-restart",
      );

      // Send a follow-up turn after restart and prove the runtime session resumed earlier model context
      await winRestarted.getByTestId("composer-input").fill("recall-context");
      await winRestarted.getByTestId("composer-send-btn").click();
      await expect(winRestarted.getByTestId("chat-transcript")).toContainText(
        "Resumed runtime context: historyLen=2, sawFalcon=true",
      );

      // Verify single-instance lock: a second Electron instance sharing persistUserData exits promptly
      // without touching desktop-state.json
      const stateFilePath = path.join(persistUserData, "desktop-state.json");
      const stateBeforeSecondLaunch = fs.readFileSync(stateFilePath, "utf8");
      const electronBinary = await appRestarted.evaluate(() => process.execPath);
      const secondExitCode = await new Promise<number | null>((resolve, reject) => {
        const secondProc = spawn(electronBinary, launchArgs, {
          env: {
            ...process.env,
            OMP_DESKTOP_FIXTURE_ROOT: fixtureCopyRoot,
            OMP_DESKTOP_USER_DATA: persistUserData,
          },
          stdio: "ignore",
          windowsHide: true,
        });
        const timer = setTimeout(() => {
          secondProc.kill();
          reject(new Error("Second Electron instance did not exit within timeout"));
        }, 10_000);
        secondProc.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      expect(secondExitCode).toBe(0);
      expect(fs.readFileSync(stateFilePath, "utf8")).toBe(stateBeforeSecondLaunch);
      expect(stateBeforeSecondLaunch).toContain("Resumed runtime context: historyLen=2, sawFalcon=true");
    } finally {
      await appRestarted.close();
    }
  } finally {
    fs.rmSync(stage2Dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

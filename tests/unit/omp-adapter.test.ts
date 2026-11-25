import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OmpRuntimeAdapter, RpcV2FrameReassembler } from "../../src/main/omp-adapter";
import type { OmpAdapterEvent } from "../../src/shared/contracts";

describe("RpcV2FrameReassembler (OMP RPC protocol v2)", () => {
  it("passes non-chunk frames straight through", () => {
    const reassembler = new RpcV2FrameReassembler();
    const res = reassembler.pushRawFrame({ type: "ready", protocolVersion: 1 });
    expect(res).toEqual({ kind: "frame", frame: { type: "ready", protocolVersion: 1 } });
  });

  it("reassembles multi-chunk base64 frames into one JSON object", () => {
    const reassembler = new RpcV2FrameReassembler();
    const logical = {
      type: "response",
      id: "p1",
      command: "get_messages_page",
      data: { text: "hello-world-chunked" },
    };
    const utf8 = Buffer.from(JSON.stringify(logical), "utf8");
    const part1 = utf8.subarray(0, 20);
    const part2 = utf8.subarray(20);

    const r1 = reassembler.pushRawFrame({
      type: "rpc_chunk",
      chunkId: "rpc-1",
      index: 0,
      count: 2,
      byteLength: utf8.length,
      data: part1.toString("base64"),
    });
    expect(r1).toEqual({ kind: "pending" });

    const r2 = reassembler.pushRawFrame({
      type: "rpc_chunk",
      chunkId: "rpc-1",
      index: 1,
      count: 2,
      byteLength: utf8.length,
      data: part2.toString("base64"),
    });
    expect(r2).toEqual({ kind: "frame", frame: logical });
  });

  it("rejects interleaved chunks and oversized frames", () => {
    const reassembler = new RpcV2FrameReassembler(32);
    const overflow = reassembler.pushRawFrame({
      type: "rpc_chunk",
      chunkId: "rpc-big",
      index: 0,
      count: 1,
      byteLength: 64,
      data: Buffer.alloc(64).toString("base64"),
    });
    expect(overflow.kind).toBe("error");
    if (overflow.kind === "error") {
      expect(overflow.code).toBe("FRAME_OVERFLOW");
    }

    const r1 = reassembler.pushRawFrame({
      type: "rpc_chunk",
      chunkId: "rpc-a",
      index: 0,
      count: 2,
      byteLength: 10,
      data: Buffer.from("12345").toString("base64"),
    });
    expect(r1).toEqual({ kind: "pending" });

    const interleaved = reassembler.pushRawFrame({
      type: "rpc_chunk",
      chunkId: "rpc-b",
      index: 1,
      count: 2,
      byteLength: 10,
      data: Buffer.from("67890").toString("base64"),
    });
    expect(interleaved.kind).toBe("error");
    if (interleaved.kind === "error") {
      expect(interleaved.code).toBe("CHUNK_PROTOCOL_ERROR");
    }
  });
});

describe("OmpRuntimeAdapter child-process lifecycle", () => {
  function writeMockOmpScript(dir: string, name: string, jsBody: string): string {
    const scriptPath = path.join(dir, `${name}.cjs`);
    fs.writeFileSync(scriptPath, jsBody, "utf8");
    return scriptPath;
  }

  it("detects pre-ready unconfigured model exit as NO_CONFIGURED_MODEL", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-adapter-unconf-"));
    try {
      const script = writeMockOmpScript(
        tmp,
        "fake-omp-unconf",
        `process.stderr.write("No default model selected. Use /login\\n"); process.exit(1);`,
      );
      const adapter = new OmpRuntimeAdapter();
      const events: OmpAdapterEvent[] = [];
      adapter.onEvent((e) => events.push(e));

      await expect(
        adapter.start({
          ompExecutablePath: process.execPath,
          ompArgsPrefix: [script],
          scope: { kind: "standalone", standaloneCwd: path.join(tmp, "standalone") },
          approvalMode: "always-ask",
          requireProtocolV2: true,
          shutdownTimeoutMs: 2_000,
        }),
      ).rejects.toThrow(/no default model/i);

      expect(
        events.some((e) => e.type === "transport_error" && e.code === "NO_CONFIGURED_MODEL"),
      ).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("negotiates v2, retains message_end frames, auto-cancels unhandled form requests, and shuts down cleanly", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-adapter-ok-"));
    try {
      const logFile = path.join(tmp, "received.jsonl");
      const script = writeMockOmpScript(
        tmp,
        "fake-omp-ok",
        `
const fs = require("node:fs");
const readline = require("node:readline");
const logFile = ${JSON.stringify(logFile)};
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
  fs.appendFileSync(logFile, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.type === "negotiate_protocol") {
    send({ id: msg.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    send({ type: "message_end", message: { role: "assistant", text: "retained-turn-1" } });
    send({ type: "extension_ui_request", id: "form-1", method: "form", html: "<form><script>evil()</script></form>" });
  } else if (msg.type === "get_state") {
    send({
      id: msg.id,
      type: "response",
      command: "get_state",
      success: true,
      data: {
        sessionId: "sess-1",
        isStreaming: false,
        isCompacting: false,
        isSettled: true,
        messageCount: 1,
        queuedMessageCount: 0,
        hasPendingAsyncWork: false,
      },
    });
  }
});
rl.on("close", () => process.exit(0));
        `,
      );

      const adapter = new OmpRuntimeAdapter();
      // Register an event forwarder (mirroring Electron main.ts) and confirm form is STILL auto-cancelled when supportsFormDialog is false
      const observedEvents: OmpAdapterEvent[] = [];
      adapter.onEvent((ev) => observedEvents.push(ev));

      const meta = await adapter.start({
        ompExecutablePath: process.execPath,
        ompArgsPrefix: [script],
        scope: { kind: "standalone", standaloneCwd: path.join(tmp, "standalone") },
        approvalMode: "always-ask",
        supportsFormDialog: false,
        requireProtocolV2: true,
        shutdownTimeoutMs: 2_000,
      });

      expect(meta.negotiatedProtocolVersion).toBe(2);
      const state = await adapter.getState();
      expect(state.sessionId).toBe("sess-1");
      expect(adapter.getRetainedMessages()).toEqual([{ role: "assistant", text: "retained-turn-1" }]);
      expect(adapter.getPromptRequestCount()).toBe(0);
      expect(
        observedEvents.some((e) => e.type === "dialog_request" && e.request.method === "form"),
      ).toBe(false);

      await adapter.dispose();

      const received = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(
        received.some(
          (m) => m.type === "extension_ui_response" && m.id === "form-1" && m.cancelled === true,
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("tears down child process without leaking when ready omits v2 or negotiate_protocol fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-adapter-reject-"));
    try {
      const exitMarkerA = path.join(tmp, "exited-a.txt");
      const scriptNoV2 = writeMockOmpScript(
        tmp,
        "fake-omp-v1-only",
        `
const fs = require("node:fs");
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(exitMarkerA)}, "exited");
  process.exit(0);
});
        `,
      );

      const adapterA = new OmpRuntimeAdapter();
      await expect(
        adapterA.start({
          ompExecutablePath: process.execPath,
          ompArgsPrefix: [scriptNoV2],
          scope: { kind: "standalone", standaloneCwd: path.join(tmp, "sa-a") },
          approvalMode: "always-ask",
          requireProtocolV2: true,
          shutdownTimeoutMs: 2_000,
        }),
      ).rejects.toThrow(/does not advertise RPC protocol v2/i);
      expect(fs.existsSync(exitMarkerA)).toBe(true);

      const exitMarkerB = path.join(tmp, "exited-b.txt");
      const scriptRejectNeg = writeMockOmpScript(
        tmp,
        "fake-omp-reject-v2",
        `
const fs = require("node:fs");
const readline = require("node:readline");
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] }) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "negotiate_protocol") {
    process.stdout.write(JSON.stringify({ id: msg.id, type: "response", command: "negotiate_protocol", success: false, error: "v2 disabled" }) + "\\n");
  }
});
rl.on("close", () => {
  fs.writeFileSync(${JSON.stringify(exitMarkerB)}, "exited");
  process.exit(0);
});
        `,
      );

      const adapterB = new OmpRuntimeAdapter();
      await expect(
        adapterB.start({
          ompExecutablePath: process.execPath,
          ompArgsPrefix: [scriptRejectNeg],
          scope: { kind: "standalone", standaloneCwd: path.join(tmp, "sa-b") },
          approvalMode: "always-ask",
          requireProtocolV2: true,
          shutdownTimeoutMs: 2_000,
        }),
      ).rejects.toThrow(/v2 negotiation failed/i);
      expect(fs.existsSync(exitMarkerB)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("creates standalone .git sentinel, enables ask dialogs, bridges dialog responses, and terminates Win32 Job Object grandchildren", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-adapter-job-"));
    try {
      const logFile = path.join(tmp, "job-frames.jsonl");
      const grandchildPidFile = path.join(tmp, "grandchild.pid");
      const standaloneDir = path.join(tmp, "standalone-cwd");

      const grandchildScript = writeMockOmpScript(
        tmp,
        "hung-grandchild",
        `setInterval(() => {}, 10000);`,
      );

      const script = writeMockOmpScript(
        tmp,
        "fake-omp-hung-with-grandchild",
        `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const child = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], {
  stdio: "ignore",
  windowsHide: true,
});
fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid), "utf8");

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
  fs.appendFileSync(${JSON.stringify(logFile)}, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.type === "negotiate_protocol") {
    send({ id: msg.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
  }
});
// Intentionally ignore stdin close so dispose() exercises timeout + Job Object / SIGKILL cleanup
setInterval(() => {}, 10000);
        `,
      );

      const adapter = new OmpRuntimeAdapter();
      await adapter.start({
        ompExecutablePath: process.execPath,
        ompArgsPrefix: [script],
        scope: { kind: "standalone", standaloneCwd: standaloneDir },
        approvalMode: "always-ask",
        supportsAskDialog: true,
        requireProtocolV2: true,
        shutdownTimeoutMs: 250,
      });

      // Standalone CWD ancestor sentinel must exist
      expect(fs.existsSync(path.join(standaloneDir, ".git"))).toBe(true);

      if (process.platform === "win32") {
        expect(adapter.isAssignedToJobObject()).toBe(true);
      }

      await adapter.respondToDialog({ id: "dlg-confirm", kind: "confirm", confirmed: true });
      await adapter.respondToDialog({ id: "dlg-val", kind: "value", value: "opt-a" });
      await adapter.respondToDialog({
        id: "dlg-ask",
        kind: "ask",
        answers: [{ id: "q1", selectedOptions: ["Yes"], customInput: "note" }],
      });

      await new Promise((r) => setTimeout(r, 80));
      const grandchildPid = Number.parseInt(fs.readFileSync(grandchildPidFile, "utf8").trim(), 10);
      expect(grandchildPid).toBeGreaterThan(0);

      await adapter.dispose();

      if (process.platform === "win32") {
        // Wait briefly for kernel Job Object termination propagation and verify grandchild is dead
        await new Promise((r) => setTimeout(r, 150));
        let alive = false;
        try {
          process.kill(grandchildPid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      } else {
        // Clean up POSIX grandchild spawned by test helper
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // already exited
        }
      }

      const frames = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(frames.some((f) => f.type === "set_ask_dialog" && f.enabled === true)).toBe(true);
      expect(
        frames.some(
          (f) => f.type === "extension_ui_response" && f.id === "dlg-confirm" && f.confirmed === true,
        ),
      ).toBe(true);
      expect(
        frames.some((f) => f.type === "extension_ui_response" && f.id === "dlg-ask"),
      ).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("propagates explicit local command completion (agentInvoked: false) while keeping omitted-data prompts active", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-adapter-local-cmd-"));
    try {
      const logFile = path.join(tmp, "frames.jsonl");
      const script = writeMockOmpScript(
        tmp,
        "fake-omp-local-cmd",
        `
const fs = require("node:fs");
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
  fs.appendFileSync(${JSON.stringify(logFile)}, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.type === "negotiate_protocol") {
    send({ id: msg.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
  } else if (msg.type === "prompt" && msg.message === "/session info") {
    // Local command ack: explicit agentInvoked: false and NO prompt_result
    send({ id: msg.id, type: "response", command: "prompt", success: true, data: { agentInvoked: false } });
  } else if (msg.type === "prompt" && msg.message === "regular-omitted-data") {
    // Regular prompt ack in OMP v19.1.1 omits data entirely and emits prompt_result later
    send({ id: msg.id, type: "response", command: "prompt", success: true });
    send({ type: "prompt_result", id: msg.id, agentInvoked: true, status: "completed", sessionSettled: true });
  } else if (msg.type === "prompt" && msg.message === "/retry") {
    send({ id: msg.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
    send({ type: "prompt_result", id: msg.id, agentInvoked: true, status: "completed", sessionSettled: true });
  }
});
rl.on("close", () => process.exit(0));
        `,
      );

      const adapter = new OmpRuntimeAdapter();
      await adapter.start({
        ompExecutablePath: process.execPath,
        ompArgsPrefix: [script],
        scope: { kind: "standalone", standaloneCwd: path.join(tmp, "standalone") },
        approvalMode: "always-ask",
        requireProtocolV2: true,
        shutdownTimeoutMs: 2_000,
      });

      const localRes = await adapter.sendPrompt("/session info");
      expect(localRes.agentInvoked).toBe(false);

      const regularRes = await adapter.sendPrompt("regular-omitted-data");
      expect(regularRes.agentInvoked).toBe(true);

      const builtinAgentRes = await adapter.sendPrompt("/retry");
      expect(builtinAgentRes.agentInvoked).toBe(true);

      // Re-run local command right before dispose() to prove isStreamingTurn was cleared (no spurious abort on shutdown)
      const localRes2 = await adapter.sendPrompt("/session info");
      expect(localRes2.agentInvoked).toBe(false);

      await adapter.dispose();

      const frames = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(frames.some((f) => f.type === "abort")).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resumes saved runtime history via --session-dir + --continue across restarts", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-adapter-resume-"));
    try {
      const sessionDir = path.join(tmp, "chat-session");
      const script = writeMockOmpScript(
        tmp,
        "fake-omp-session-resume",
        `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

const argv = process.argv.slice(2);
const dirIdx = argv.indexOf("--session-dir");
const sessionDir = dirIdx !== -1 ? argv[dirIdx + 1] : null;
const hasContinue = argv.includes("--continue");
const sessionFile = sessionDir ? path.join(sessionDir, "latest.json") : null;

// Mirror OMP v19.1.1: --session-dir alone starts fresh; only --continue loads saved history
let history = [];
if (sessionFile && hasContinue && fs.existsSync(sessionFile)) {
  history = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
}

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
  } else if (msg.type === "get_state") {
    send({
      id: msg.id,
      type: "response",
      command: "get_state",
      success: true,
      data: {
        sessionId: "sess-resumable",
        sessionFile: sessionFile || undefined,
        isStreaming: false,
        isCompacting: false,
        isSettled: true,
        messageCount: history.length,
        queuedMessageCount: 0,
        hasPendingAsyncWork: false,
      },
    });
  } else if (msg.type === "get_messages_page") {
    send({
      id: msg.id,
      type: "response",
      command: "get_messages_page",
      success: true,
      data: {
        messages: history,
        totalMessages: history.length,
      },
    });
  } else if (msg.type === "prompt") {
    history.push({ role: "user", text: msg.message });
    history.push({ role: "assistant", text: "Recorded: " + msg.message });
    if (sessionFile) {
      fs.writeFileSync(sessionFile, JSON.stringify(history), "utf8");
    }
    send({ id: msg.id, type: "response", command: "prompt", success: true });
    send({ type: "message_end", message: { role: "assistant", text: "Recorded: " + msg.message } });
    send({ type: "prompt_result", id: msg.id, agentInvoked: true, status: "completed", sessionSettled: true });
  }
});
rl.on("close", () => process.exit(0));
        `,
      );

      // Run 1: write a turn into sessionDir
      const adapter1 = new OmpRuntimeAdapter();
      await adapter1.start({
        ompExecutablePath: process.execPath,
        ompArgsPrefix: [script],
        scope: { kind: "standalone", standaloneCwd: path.join(tmp, "standalone") },
        approvalMode: "always-ask",
        sessionDir,
        requireProtocolV2: true,
        shutdownTimeoutMs: 2_000,
      });
      await adapter1.sendPrompt("Project codename is Falcon");
      await adapter1.dispose();

      // Run 2: restart against the same sessionDir -> runtime history must already be loaded
      const adapter2 = new OmpRuntimeAdapter();
      await adapter2.start({
        ompExecutablePath: process.execPath,
        ompArgsPrefix: [script],
        scope: { kind: "standalone", standaloneCwd: path.join(tmp, "standalone") },
        approvalMode: "always-ask",
        sessionDir,
        requireProtocolV2: true,
        shutdownTimeoutMs: 2_000,
      });
      const state = await adapter2.getState();
      expect(state.messageCount).toBe(2);
      const page = await adapter2.getMessagesPage();
      expect(page.totalMessages).toBe(2);
      expect(JSON.stringify(page.messages)).toContain("Project codename is Falcon");
      await adapter2.dispose();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("unblocks negotiate_protocol when an extension emits a session_start dialog before handshake completes", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-adapter-startup-dlg-"));
    try {
      const script = writeMockOmpScript(
        tmp,
        "fake-omp-startup-dialog",
        `
const readline = require("node:readline");
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

// Emit ready before running extension session_start dialog (exact OMP v19.1.1 behavior)
send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
  supportsBashExcludeFromContext: true,
});
send({
  type: "extension_ui_request",
  id: "startup-confirm-1",
  method: "confirm",
  title: "Trust workspace extension?",
  message: "Allow session_start hook to initialize",
});

let startupApproved = false;
let queuedNegotiate = null;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
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
  }
});
rl.on("close", () => process.exit(0));
        `,
      );

      const adapter = new OmpRuntimeAdapter();
      let startupDialogHandled = false;
      adapter.onEvent((ev) => {
        if (ev.type === "dialog_request" && ev.request.id === "startup-confirm-1") {
          expect(adapter.isTransportWritable()).toBe(true);
          startupDialogHandled = true;
          void adapter.respondToDialog({ id: ev.request.id, kind: "confirm", confirmed: true });
        }
      });

      const meta = await adapter.start({
        ompExecutablePath: process.execPath,
        ompArgsPrefix: [script],
        scope: { kind: "standalone", standaloneCwd: path.join(tmp, "standalone") },
        approvalMode: "always-ask",
        requireProtocolV2: true,
        shutdownTimeoutMs: 2_000,
      });

      expect(startupDialogHandled).toBe(true);
      expect(meta.negotiatedProtocolVersion).toBe(2);
      await adapter.dispose();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("terminates Job Object grandchildren immediately on unexpected OMP exit and closes handle exactly once", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-adapter-crash-job-"));
    try {
      const grandchildPidFile = path.join(tmp, "crash-grandchild.pid");
      const grandchildScript = writeMockOmpScript(
        tmp,
        "crash-grandchild",
        `setInterval(() => {}, 10000);`,
      );
      const script = writeMockOmpScript(
        tmp,
        "fake-omp-crash-with-child",
        `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const child = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], {
  stdio: "ignore",
  windowsHide: true,
});
fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid), "utf8");

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
  } else if (msg.type === "prompt" && msg.message === "trigger-crash") {
    send({ id: msg.id, type: "response", command: "prompt", success: true });
    // Simulate unexpected OMP crash while grandchild tool process is still alive
    setTimeout(() => process.exit(42), 30);
  }
});
        `,
      );

      let mockCloseCount = 0;
      const adapter =
        process.platform === "win32"
          ? new OmpRuntimeAdapter()
          : new OmpRuntimeAdapter({
              requireJobObject: true,
              createJobObject: () => {
                let assigned = false;
                return {
                  isAssigned: () => assigned,
                  assignProcess: () => {
                    assigned = true;
                    return { ok: true };
                  },
                  terminateAndClose: () => {
                    if (assigned) {
                      assigned = false;
                      mockCloseCount += 1;
                    }
                  },
                };
              },
            });

      const exitedPromise = new Promise<OmpAdapterEvent>((resolve) => {
        adapter.onEvent((ev) => {
          if (ev.type === "transport_error" && ev.code === "PROCESS_EXITED") {
            resolve(ev);
          }
        });
      });

      await adapter.start({
        ompExecutablePath: process.execPath,
        ompArgsPrefix: [script],
        scope: { kind: "standalone", standaloneCwd: path.join(tmp, "standalone") },
        approvalMode: "always-ask",
        requireProtocolV2: true,
        shutdownTimeoutMs: 2_000,
      });

      expect(adapter.isAssignedToJobObject()).toBe(true);
      await adapter.sendPrompt("trigger-crash");

      const exitEvent = await exitedPromise;
      expect(exitEvent.type).toBe("transport_error");
      expect(adapter.isAssignedToJobObject()).toBe(false);

      const grandchildPid = Number.parseInt(fs.readFileSync(grandchildPidFile, "utf8").trim(), 10);
      expect(grandchildPid).toBeGreaterThan(0);

      if (process.platform === "win32") {
        // Without calling adapter.dispose(), the Job Object must already have killed the surviving grandchild!
        await new Promise((r) => setTimeout(r, 150));
        let alive = false;
        try {
          process.kill(grandchildPid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      } else {
        expect(mockCloseCount).toBe(1);
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // already dead
        }
      }

      // Subsequent idempotent dispose must not double-close the Job Object handle
      await adapter.dispose();
      await adapter.dispose();
      if (process.platform !== "win32") {
        expect(mockCloseCount).toBe(1);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("fails closed and terminates child when Job Object assignment fails on a live process", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-adapter-job-fail-"));
    try {
      const pidFile = path.join(tmp, "live-child.pid");
      const liveScript = writeMockOmpScript(
        tmp,
        "fake-omp-live",
        `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), "utf8");
setInterval(() => {}, 10000);
        `,
      );

      let assignedPid = 0;
      const adapter = new OmpRuntimeAdapter({
        requireJobObject: true,
        createJobObject: () => ({
          isAssigned: () => false,
          assignProcess: (pid: number) => {
            assignedPid = pid;
            return {
              ok: false,
              reason: "Simulated SetInformationJobObject access denied",
              processAlreadyExited: false,
            };
          },
          terminateAndClose: () => {},
        }),
      });

      const events: OmpAdapterEvent[] = [];
      adapter.onEvent((e) => events.push(e));

      await expect(
        adapter.start({
          ompExecutablePath: process.execPath,
          ompArgsPrefix: [liveScript],
          scope: { kind: "standalone", standaloneCwd: path.join(tmp, "standalone") },
          approvalMode: "always-ask",
          requireProtocolV2: true,
          shutdownTimeoutMs: 2_000,
        }),
      ).rejects.toThrow(/Failed to assign OMP process.*Job Object/i);

      expect(assignedPid).toBeGreaterThan(0);
      expect(events.some((e) => e.type === "transport_error" && e.code === "PROCESS_EXITED")).toBe(
        true,
      );

      // Confirm the unsupervised child was terminated rather than left running
      await new Promise((r) => setTimeout(r, 150));
      let alive = false;
      try {
        process.kill(assignedPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("fails closed before spawning any child process when Job Object prepare() fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-adapter-job-prep-"));
    try {
      const markerFile = path.join(tmp, "should-never-run.txt");
      const markerScript = writeMockOmpScript(
        tmp,
        "fake-omp-marker",
        `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, "spawned");`,
      );

      let assignCalled = false;
      const adapter = new OmpRuntimeAdapter({
        requireJobObject: true,
        createJobObject: () => ({
          isAssigned: () => false,
          prepare: () => ({ ok: false, reason: "Simulated CreateJobObjectW failure" }),
          assignProcess: () => {
            assignCalled = true;
            return { ok: true };
          },
          terminateAndClose: () => {},
        }),
      });

      await expect(
        adapter.start({
          ompExecutablePath: process.execPath,
          ompArgsPrefix: [markerScript],
          scope: { kind: "standalone", standaloneCwd: path.join(tmp, "standalone") },
          approvalMode: "always-ask",
          requireProtocolV2: true,
          shutdownTimeoutMs: 2_000,
        }),
      ).rejects.toThrow(/Failed to prepare Windows Job Object/i);

      expect(assignCalled).toBe(false);
      expect(fs.existsSync(markerFile)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("completes sessionDir setup before preparing Job Object so filesystem errors never leak handles", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-adapter-job-fs-"));
    try {
      // Create a regular file where sessionDir is expected so fs.mkdirSync(sessionDir) fails
      const blockingFile = path.join(tmp, "not-a-dir");
      fs.writeFileSync(blockingFile, "block", "utf8");

      let prepareCalled = false;
      const adapter = new OmpRuntimeAdapter({
        requireJobObject: true,
        createJobObject: () => ({
          isAssigned: () => false,
          prepare: () => {
            prepareCalled = true;
            return { ok: true };
          },
          assignProcess: () => ({ ok: true }),
          terminateAndClose: () => {},
        }),
      });

      await expect(
        adapter.start({
          ompExecutablePath: process.execPath,
          scope: { kind: "standalone", standaloneCwd: path.join(tmp, "standalone") },
          approvalMode: "always-ask",
          sessionDir: path.join(blockingFile, "nested"),
          requireProtocolV2: true,
          shutdownTimeoutMs: 2_000,
        }),
      ).rejects.toThrow();

      expect(prepareCalled).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

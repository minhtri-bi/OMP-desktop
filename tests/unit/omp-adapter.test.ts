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
      const meta = await adapter.start({
        ompExecutablePath: process.execPath,
        ompArgsPrefix: [script],
        scope: { kind: "standalone", standaloneCwd: path.join(tmp, "standalone") },
        approvalMode: "always-ask",
        requireProtocolV2: true,
        shutdownTimeoutMs: 2_000,
      });

      expect(meta.negotiatedProtocolVersion).toBe(2);
      const state = await adapter.getState();
      expect(state.sessionId).toBe("sess-1");
      expect(adapter.getRetainedMessages()).toEqual([{ role: "assistant", text: "retained-turn-1" }]);
      expect(adapter.getPromptRequestCount()).toBe(0);

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
});

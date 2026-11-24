import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import type {
  OmpAdapterEvent,
  OmpDialogRequest,
  OmpDialogResponse,
  OmpProcessConfig,
  OmpReadyMetadata,
  OmpSessionSnapshot,
} from "../shared/contracts";

interface ChunkAccumulator {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  buffers: Buffer[];
  totalBytes: number;
}

export class RpcV2FrameReassembler {
  private active: ChunkAccumulator | null = null;
  private maxReassembledBytes: number;
  private readonly utf8Decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(maxReassembledBytes = 64 * 1024 * 1024) {
    this.maxReassembledBytes = maxReassembledBytes;
  }

  setMaxReassembledBytes(limit: number): void {
    if (limit > 0) {
      this.maxReassembledBytes = limit;
    }
  }

  pushRawFrame(frame: Record<string, unknown>):
    | { kind: "frame"; frame: Record<string, unknown> }
    | { kind: "pending" }
    | { kind: "error"; code: "CHUNK_PROTOCOL_ERROR" | "FRAME_OVERFLOW"; message: string } {
    if (frame.type !== "rpc_chunk") {
      if (this.active !== null) {
        this.active = null;
        return {
          kind: "error",
          code: "CHUNK_PROTOCOL_ERROR",
          message: "Received non-chunk frame while an rpc_chunk sequence was incomplete.",
        };
      }
      return { kind: "frame", frame };
    }

    const chunkId = frame.chunkId;
    const index = frame.index;
    const count = frame.count;
    const byteLength = frame.byteLength;
    const data = frame.data;

    if (
      typeof chunkId !== "string" ||
      !chunkId ||
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count <= 0 ||
      typeof byteLength !== "number" ||
      !Number.isInteger(byteLength) ||
      byteLength < 0 ||
      typeof data !== "string"
    ) {
      this.active = null;
      return {
        kind: "error",
        code: "CHUNK_PROTOCOL_ERROR",
        message: "Malformed rpc_chunk header fields.",
      };
    }

    if (byteLength > this.maxReassembledBytes) {
      this.active = null;
      return {
        kind: "error",
        code: "FRAME_OVERFLOW",
        message: `Declared rpc_chunk byteLength (${byteLength}) exceeds limit (${this.maxReassembledBytes}).`,
      };
    }

    if (this.active === null) {
      if (index !== 0) {
        return {
          kind: "error",
          code: "CHUNK_PROTOCOL_ERROR",
          message: `Expected initial chunk index 0, received ${index}.`,
        };
      }
      this.active = {
        chunkId,
        count,
        byteLength,
        nextIndex: 0,
        buffers: [],
        totalBytes: 0,
      };
    } else if (
      this.active.chunkId !== chunkId ||
      this.active.count !== count ||
      this.active.byteLength !== byteLength ||
      this.active.nextIndex !== index
    ) {
      this.active = null;
      return {
        kind: "error",
        code: "CHUNK_PROTOCOL_ERROR",
        message: "Interleaved or out-of-order rpc_chunk sequence.",
      };
    }

    const decoded = Buffer.from(data, "base64");
    this.active.buffers.push(decoded);
    this.active.totalBytes += decoded.length;
    this.active.nextIndex += 1;

    if (this.active.totalBytes > this.maxReassembledBytes) {
      this.active = null;
      return {
        kind: "error",
        code: "FRAME_OVERFLOW",
        message: "Reassembled rpc_chunk payload exceeded maxReassembledFrameBytes.",
      };
    }

    if (this.active.nextIndex < this.active.count) {
      return { kind: "pending" };
    }

    const completed = this.active;
    this.active = null;
    if (completed.totalBytes !== completed.byteLength) {
      return {
        kind: "error",
        code: "CHUNK_PROTOCOL_ERROR",
        message: `Reassembled byte length (${completed.totalBytes}) does not match declared byteLength (${completed.byteLength}).`,
      };
    }

    const combined = Buffer.concat(completed.buffers);
    let jsonText: string;
    try {
      jsonText = this.utf8Decoder.decode(combined);
    } catch {
      return {
        kind: "error",
        code: "CHUNK_PROTOCOL_ERROR",
        message: "Reassembled rpc_chunk payload is not valid UTF-8.",
      };
    }

    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          kind: "error",
          code: "CHUNK_PROTOCOL_ERROR",
          message: "Reassembled rpc_chunk payload did not parse to a JSON object.",
        };
      }
      return { kind: "frame", frame: parsed as Record<string, unknown> };
    } catch {
      return {
        kind: "error",
        code: "CHUNK_PROTOCOL_ERROR",
        message: "Reassembled rpc_chunk payload is invalid JSON.",
      };
    }
  }
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

export class OmpRuntimeAdapter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private config: OmpProcessConfig | null = null;
  private readyMetadata: OmpReadyMetadata | null = null;
  private readonly reassembler = new RpcV2FrameReassembler();
  private readonly listeners = new Set<(event: OmpAdapterEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly retainedMessages: unknown[] = [];
  private stdoutBuffer = "";
  private stderrText = "";
  private requestCounter = 0;
  private promptRequestCount = 0;
  private readyResolve: ((meta: OmpReadyMetadata) => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private disposed = false;

  getPromptRequestCount(): number {
    return this.promptRequestCount;
  }

  getRetainedMessages(): readonly unknown[] {
    return this.retainedMessages;
  }

  onEvent(listener: (event: OmpAdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: OmpAdapterEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async start(config: OmpProcessConfig): Promise<OmpReadyMetadata> {
    if (this.child) {
      throw new Error("OMP adapter is already started.");
    }
    this.config = config;
    this.disposed = false;
    this.stderrText = "";
    this.stdoutBuffer = "";

    const cwd =
      config.scope.kind === "project"
        ? config.scope.canonicalWorkspaceRoot
        : config.scope.standaloneCwd;
    if (config.scope.kind === "standalone") {
      fs.mkdirSync(cwd, { recursive: true });
    }

    const args = [
      ...(config.ompArgsPrefix ?? []),
      "--mode",
      "rpc-ui",
      "--approval-mode",
      config.approvalMode,
    ];
    if (config.sessionDir) {
      args.push("--session-dir", config.sessionDir);
    } else {
      args.push("--no-session");
    }
    if (config.modelOverride) {
      args.push("--model", config.modelOverride);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (config.agentDirOverride) {
      env.PI_CODING_AGENT_DIR = config.agentDirOverride;
      delete env.OMP_PROFILE;
      delete env.PI_PROFILE;
    }

    const child = spawn(config.ompExecutablePath, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    const readyPromise = new Promise<OmpReadyMetadata>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrText += chunk;
    });

    child.on("error", (err) => {
      const wrapped = new Error(`Failed to spawn OMP: ${err.message}`);
      this.failStartupOrPending(wrapped, "PROCESS_EXITED");
    });

    child.on("exit", (code, signal) => {
      this.child = null;
      const isUnconfigured = /No default model selected/i.test(this.stderrText);
      if (!this.readyMetadata && isUnconfigured) {
        const err = new Error(
          "OMP exited before ready: no default model or provider credentials configured.",
        );
        this.emit({
          type: "transport_error",
          code: "NO_CONFIGURED_MODEL",
          message: err.message,
          recoverable: false,
        });
        this.failStartupOrPending(err, "NO_CONFIGURED_MODEL", true);
        return;
      }
      if (!this.disposed) {
        const err = new Error(
          `OMP process exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        );
        this.emit({
          type: "transport_error",
          code: "PROCESS_EXITED",
          message: err.message,
          recoverable: false,
        });
        this.failStartupOrPending(err, "PROCESS_EXITED", true);
      }
    });

    try {
      const initialMeta = await readyPromise;
      if (config.requireProtocolV2) {
        const negResp = await this.sendCommand({
          type: "negotiate_protocol",
          protocolVersion: 2,
        });
        if (negResp.success !== true) {
          throw new Error(
            `OMP RPC protocol v2 negotiation failed: ${String(negResp.error ?? "unknown")}`,
          );
        }
      }

      this.readyMetadata = {
        ...initialMeta,
        negotiatedProtocolVersion: 2,
      };
      this.emit({ type: "ready", metadata: this.readyMetadata });
      return this.readyMetadata;
    } catch (err) {
      await this.dispose();
      throw err;
    }
  }

  private failStartupOrPending(
    err: Error,
    _code: "NO_CONFIGURED_MODEL" | "PROCESS_EXITED",
    alreadyEmitted = false,
  ): void {
    if (!alreadyEmitted) {
      this.emit({
        type: "transport_error",
        code: _code,
        message: err.message,
        recoverable: false,
      });
    }
    if (this.readyReject) {
      const rej = this.readyReject;
      this.readyResolve = null;
      this.readyReject = null;
      rej(err);
    }
    for (const [id, req] of this.pending.entries()) {
      this.pending.delete(id);
      req.reject(err);
    }
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        this.handleJsonLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleJsonLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit({
        type: "transport_error",
        code: "PARSE_ERROR",
        message: "Received invalid JSON frame from OMP stdout.",
        recoverable: true,
      });
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const result = this.reassembler.pushRawFrame(parsed as Record<string, unknown>);
    if (result.kind === "pending") {
      return;
    }
    if (result.kind === "error") {
      this.emit({
        type: "transport_error",
        code: result.code,
        message: result.message,
        recoverable: result.code === "FRAME_OVERFLOW",
      });
      return;
    }

    this.dispatchFrame(result.frame);
  }

  private dispatchFrame(frame: Record<string, unknown>): void {
    const type = frame.type;

    if (type === "ready" && this.readyResolve) {
      const supported = Array.isArray(frame.supportedProtocolVersions)
        ? (frame.supportedProtocolVersions as number[])
        : [];
      const maxFrameBytes =
        typeof frame.maxFrameBytes === "number" ? frame.maxFrameBytes : 1024 * 1024;
      const maxReassembledFrameBytes =
        typeof frame.maxReassembledFrameBytes === "number"
          ? frame.maxReassembledFrameBytes
          : 64 * 1024 * 1024;
      this.reassembler.setMaxReassembledBytes(maxReassembledFrameBytes);

      if (!supported.includes(2)) {
        const err = new Error("OMP runtime does not advertise RPC protocol v2.");
        this.failStartupOrPending(err, "PROCESS_EXITED");
        return;
      }

      const resolve = this.readyResolve;
      this.readyResolve = null;
      this.readyReject = null;
      resolve({
        ompVersion: typeof frame.version === "string" ? frame.version : "19.1.1",
        negotiatedProtocolVersion: 2,
        maxFrameBytes,
        maxReassembledFrameBytes,
        supportsBashExcludeFromContext: frame.supportsBashExcludeFromContext === true,
      });
      return;
    }

    if (type === "response") {
      const id = typeof frame.id === "string" ? frame.id : undefined;
      if (id && this.pending.has(id)) {
        const entry = this.pending.get(id)!;
        this.pending.delete(id);
        entry.resolve(frame);
        return;
      }
      if (frame.command === "parse" && frame.success === false) {
        this.emit({
          type: "transport_error",
          code: "PARSE_ERROR",
          message: String(frame.error ?? "OMP rejected malformed inbound JSON."),
          recoverable: true,
        });
      }
      return;
    }

    if (type === "message_update") {
      this.emit({ type: "message_update", payload: frame });
      return;
    }

    if (type === "message_end") {
      this.retainedMessages.push(frame.message ?? frame);
      this.emit({ type: "message_end", message: frame.message ?? frame });
      return;
    }

    if (type === "prompt_result") {
      this.emit({
        type: "prompt_result",
        id: typeof frame.id === "string" ? frame.id : undefined,
        agentInvoked: frame.agentInvoked === true,
        status:
          frame.status === "aborted" || frame.status === "error"
            ? frame.status
            : "completed",
        error: typeof frame.error === "string" ? frame.error : undefined,
        sessionSettled: frame.sessionSettled === true,
      });
      return;
    }

    if (type === "session_settled") {
      this.emit({ type: "session_settled" });
      return;
    }

    if (type === "available_commands_update" && Array.isArray(frame.commands)) {
      this.emit({ type: "available_commands_update", commands: frame.commands });
      return;
    }

    if (type === "rpc_frame_error") {
      this.emit({
        type: "transport_error",
        code: "FRAME_OVERFLOW",
        message: String(frame.error ?? "OMP frame exceeded transport limit."),
        recoverable: true,
      });
      return;
    }

    if (type === "extension_ui_request") {
      this.handleExtensionUiRequest(frame);
    }
  }

  private handleExtensionUiRequest(frame: Record<string, unknown>): void {
    const id = typeof frame.id === "string" ? frame.id : "";
    const method = typeof frame.method === "string" ? frame.method : "";

    if (method === "cancel" && typeof frame.targetId === "string") {
      this.emit({ type: "dialog_cancel", targetId: frame.targetId });
      return;
    }
    if (method === "open_url" && typeof frame.url === "string") {
      this.emit({
        type: "open_url",
        url: frame.url,
        launchUrl: typeof frame.launchUrl === "string" ? frame.launchUrl : undefined,
        instructions: typeof frame.instructions === "string" ? frame.instructions : undefined,
      });
      return;
    }
    if (method === "notify" && typeof frame.message === "string") {
      this.emit({
        type: "notify",
        message: frame.message,
        level: typeof frame.level === "string" ? frame.level : undefined,
      });
      return;
    }

    if (!id) {
      return;
    }

    // Security invariant: never inject raw form HTML into the desktop shell; always cancel unless a safe declarative form renderer is explicitly enabled.
    if (method === "form") {
      if (this.config?.supportsFormDialog !== true) {
        void this.respondToDialog({ id, kind: "cancel" });
        this.emit({
          type: "notify",
          message: "Cancelled unsupported OMP HTML form dialog to prevent turn stall.",
          level: "warning",
        });
        return;
      }
      const request: OmpDialogRequest = {
        id,
        method: "form",
        rawHtmlForm: typeof frame.html === "string" ? frame.html : "",
        timeoutMs: typeof frame.timeout === "number" ? frame.timeout : undefined,
      };
      this.emit({ type: "dialog_request", request });
      return;
    }

    if (method === "confirm") {
      this.emit({
        type: "dialog_request",
        request: {
          id,
          method: "confirm",
          title: String(frame.title ?? "Confirm"),
          message: String(frame.message ?? ""),
          timeoutMs: typeof frame.timeout === "number" ? frame.timeout : undefined,
        },
      });
      return;
    }

    if (method === "select" && Array.isArray(frame.options)) {
      this.emit({
        type: "dialog_request",
        request: {
          id,
          method: "select",
          title: String(frame.title ?? "Select"),
          options: frame.options.map(String),
          optionDetails: Array.isArray(frame.optionDetails)
            ? (frame.optionDetails as Array<{ description?: string }>)
            : undefined,
          initialIndex: typeof frame.initialIndex === "number" ? frame.initialIndex : undefined,
          selectionMarker:
            frame.selectionMarker === "radio" || frame.selectionMarker === "checkbox"
              ? frame.selectionMarker
              : undefined,
          checkedIndices: Array.isArray(frame.checkedIndices)
            ? (frame.checkedIndices as number[])
            : undefined,
          markableCount: typeof frame.markableCount === "number" ? frame.markableCount : undefined,
          timeoutMs: typeof frame.timeout === "number" ? frame.timeout : undefined,
        },
      });
      return;
    }

    if (method === "input" || method === "editor") {
      this.emit({
        type: "dialog_request",
        request: {
          id,
          method,
          title: String(frame.title ?? "Input"),
          placeholder: typeof frame.placeholder === "string" ? frame.placeholder : undefined,
          secret: frame.secret === true,
          timeoutMs: typeof frame.timeout === "number" ? frame.timeout : undefined,
        },
      });
      return;
    }

    if (method === "ask" && Array.isArray(frame.questions)) {
      this.emit({
        type: "dialog_request",
        request: {
          id,
          method: "ask",
          questions: frame.questions as Extract<OmpDialogRequest, { method: "ask" }>["questions"],
          timeoutMs: typeof frame.timeout === "number" ? frame.timeout : undefined,
        },
      });
    }
  }

  private writeRawFrame(payload: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("OMP RPC process is not running.");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  private sendCommand(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requestCounter += 1;
    const id = `omp-${this.requestCounter}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.writeRawFrame({ id, ...command });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async getState(): Promise<OmpSessionSnapshot> {
    const resp = await this.sendCommand({ type: "get_state" });
    if (resp.success !== true || !resp.data || typeof resp.data !== "object") {
      throw new Error(`get_state failed: ${String(resp.error ?? "unknown")}`);
    }
    return resp.data as OmpSessionSnapshot;
  }

  async openSession(sessionDir: string): Promise<OmpSessionSnapshot> {
    const resp = await this.sendCommand({ type: "open_session", sessionDir });
    if (resp.success !== true) {
      throw new Error(`open_session failed: ${String(resp.error ?? "unknown")}`);
    }
    return this.getState();
  }

  async getMessagesPage(cursor?: string, limit = 100): Promise<{
    messages: unknown[];
    nextCursor?: string;
    totalMessages: number;
  }> {
    const resp = await this.sendCommand({
      type: "get_messages_page",
      ...(cursor ? { cursor } : {}),
      limit,
    });
    if (resp.success !== true || !resp.data || typeof resp.data !== "object") {
      const code = typeof resp.code === "string" ? ` (${resp.code})` : "";
      throw new Error(`get_messages_page failed${code}: ${String(resp.error ?? "unknown")}`);
    }
    return resp.data as {
      messages: unknown[];
      nextCursor?: string;
      totalMessages: number;
    };
  }

  async sendPrompt(
    message: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<{ id: string }> {
    this.promptRequestCount += 1;
    const resp = await this.sendCommand({
      type: "prompt",
      message,
      ...(streamingBehavior ? { streamingBehavior } : {}),
    });
    if (resp.success !== true) {
      throw new Error(`prompt failed: ${String(resp.error ?? "unknown")}`);
    }
    return { id: String(resp.id ?? "") };
  }

  async abort(): Promise<void> {
    const resp = await this.sendCommand({ type: "abort" });
    if (resp.success !== true) {
      throw new Error(`abort failed: ${String(resp.error ?? "unknown")}`);
    }
  }

  async respondToDialog(response: OmpDialogResponse): Promise<void> {
    if (response.kind === "confirm") {
      this.writeRawFrame({
        type: "extension_ui_response",
        id: response.id,
        confirmed: response.confirmed,
      });
    } else if (response.kind === "value") {
      this.writeRawFrame({
        type: "extension_ui_response",
        id: response.id,
        value: response.value,
      });
    } else if (response.kind === "ask") {
      this.writeRawFrame({
        type: "extension_ui_response",
        id: response.id,
        answers: response.answers,
      });
    } else if (response.kind === "form") {
      this.writeRawFrame({
        type: "extension_ui_response",
        id: response.id,
        data: response.data,
      });
    } else {
      this.writeRawFrame({
        type: "extension_ui_response",
        id: response.id,
        cancelled: true,
        ...(response.timedOut ? { timedOut: true } : {}),
      });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    if (!child) {
      return;
    }

    const timeoutMs = this.config?.shutdownTimeoutMs ?? 5_000;
    const exitPromise = new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });

    try {
      child.stdin.end();
    } catch {
      // ignore already-closed stdin
    }

    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (child.exitCode === null) {
            if (process.platform === "win32" && child.pid) {
              spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
            } else {
              child.kill("SIGKILL");
            }
          }
          resolve();
        }, timeoutMs);
      }),
    ]);

    if (timer) {
      clearTimeout(timer);
    }
    this.child = null;
  }
}

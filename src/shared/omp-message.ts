export function extractAssistantText(
  rawMessage: unknown,
): { role: "assistant" | "system"; text: string } | null {
  if (!rawMessage || typeof rawMessage !== "object") {
    return null;
  }
  const msg = rawMessage as Record<string, unknown>;
  const role = msg.role;
  if (role === "user" || role === "toolResult" || role === "tool") {
    return null;
  }
  const normalizedRole: "assistant" | "system" = role === "system" ? "system" : "assistant";

  if (typeof msg.text === "string" && msg.text.length > 0) {
    return { role: normalizedRole, text: msg.text };
  }
  if (typeof msg.content === "string" && msg.content.length > 0) {
    return { role: normalizedRole, text: msg.content };
  }
  if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block && typeof block === "object") {
        const record = block as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") {
          parts.push(record.text);
        }
      }
    }
    const joined = parts.join("\n");
    if (joined.length > 0) {
      return { role: normalizedRole, text: joined };
    }
  }
  return null;
}

/**
 * Extracts updated partial assistant text from an OMP `message_update` frame.
 * Prefers authoritative partial `message` snapshots when present, falling back to `text_delta` / `delta`.
 */
export function extractStreamingUpdateText(rawPayload: unknown, previousText: string): string | null {
  if (!rawPayload || typeof rawPayload !== "object") {
    return null;
  }
  const payload = rawPayload as Record<string, unknown>;

  if (payload.message && typeof payload.message === "object") {
    const msgRecord = payload.message as Record<string, unknown>;
    if (msgRecord.role === "user" || msgRecord.role === "toolResult" || msgRecord.role === "tool") {
      return null;
    }
    const snapshot = extractAssistantText(payload.message);
    if (snapshot !== null) {
      return snapshot.text;
    }
  }

  if (payload.assistantMessageEvent && typeof payload.assistantMessageEvent === "object") {
    const ev = payload.assistantMessageEvent as Record<string, unknown>;
    if (
      (ev.type === "text_delta" || ev.type === undefined) &&
      typeof ev.delta === "string"
    ) {
      return previousText + ev.delta;
    }
    // Non-text streaming activity (e.g., thinking_delta / toolcall_delta) keeps streaming card visible
    return previousText;
  }

  if (typeof payload.delta === "string") {
    return previousText + payload.delta;
  }

  if (typeof payload.text === "string") {
    return payload.text;
  }

  return previousText;
}

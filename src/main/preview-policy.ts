export const PREVIEW_PROTOCOL_SCHEME = "omp-preview";

const BLOCKED_URI_SCHEMES = new Set([
  "file:",
  "javascript:",
  "data:",
  "vbscript:",
  "ms-msdt:",
  "cmd:",
  "shell:",
  "powershell:",
  "smb:",
  "ftp:",
  "ws:",
  "wss:",
  "chrome:",
  "chrome-extension:",
  "devtools:",
]);

export interface PreviewNavigationCheck {
  allowed: boolean;
  reason?: string;
}

export function validateNavigationUrl(
  targetUrl: string,
  viewKind: "html-preview" | "browser",
  expectedWorkspaceToken?: string,
): PreviewNavigationCheck {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { allowed: false, reason: "Invalid URL syntax." };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (BLOCKED_URI_SCHEMES.has(protocol)) {
    return { allowed: false, reason: `Blocked URI scheme "${protocol}".` };
  }

  if (viewKind === "html-preview") {
    if (protocol !== `${PREVIEW_PROTOCOL_SCHEME}:`) {
      return {
        allowed: false,
        reason: `Local HTML preview navigation must stay within ${PREVIEW_PROTOCOL_SCHEME}://.`,
      };
    }
    if (expectedWorkspaceToken && parsed.hostname.toLowerCase() !== expectedWorkspaceToken.toLowerCase()) {
      return {
        allowed: false,
        reason: "Cross-workspace preview navigation is blocked.",
      };
    }
    return { allowed: true };
  }

  // Visible browser tab
  if (protocol === "https:" || protocol === "http:") {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Unsupported browser navigation scheme "${protocol}".`,
  };
}

export function shouldAllowPreviewNetworkRequest(params: {
  requestUrl: string;
  viewKind: "html-preview" | "browser";
  workspaceToken?: string;
  allowExternalNetwork: boolean;
}): PreviewNavigationCheck {
  let parsed: URL;
  try {
    parsed = new URL(params.requestUrl);
  } catch {
    return { allowed: false, reason: "Invalid request URL." };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "file:" || protocol === "ms-msdt:" || protocol === "cmd:" || protocol === "shell:" || protocol === "smb:") {
    return { allowed: false, reason: `Dangerous request scheme "${protocol}" is always blocked.` };
  }

  if (params.viewKind === "browser") {
    if (protocol === "https:" || protocol === "http:" || protocol === "data:" || protocol === "blob:") {
      return { allowed: true };
    }
    return { allowed: false, reason: `Disallowed browser request scheme "${protocol}".` };
  }

  // Local interactive HTML preview
  if (protocol === `${PREVIEW_PROTOCOL_SCHEME}:`) {
    if (
      params.workspaceToken &&
      parsed.hostname.toLowerCase() !== params.workspaceToken.toLowerCase()
    ) {
      return { allowed: false, reason: "Cross-workspace preview subresource request blocked." };
    }
    return { allowed: true };
  }

  if (protocol === "data:" || protocol === "blob:") {
    return { allowed: true };
  }

  if (protocol === "https:" || protocol === "http:") {
    if (!params.allowExternalNetwork) {
      return {
        allowed: false,
        reason: "External network access is blocked by default for local HTML previews.",
      };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: `Disallowed preview request scheme "${protocol}".` };
}

export function mimeTypeForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".wasm")) return "application/wasm";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

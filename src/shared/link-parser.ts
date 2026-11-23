import type { ChatLinkItem, LineAnchor } from "./contracts";

const BLOCKED_SCHEMES_RE = /^(?:javascript|vbscript|data|mailto|tel|blob|about):/i;
const EXTERNAL_URL_RE = /^https?:\/\//i;
const HASH_LINE_ANCHOR_RE = /^(.*)#L(\d+)(?:-L?(\d+))?$/i;
const COLON_LINE_ANCHOR_RE = /^(.*\.[a-zA-Z0-9_-]+):(\d+)(?:-(\d+))?$/;

const RECOGNIZED_EXT_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|json|yml|yaml|toml|md|markdown|txt|html|htm|css|scss|less|pdf|ps1|sh|bash|zsh|sql|xml|csv|env|ini|cfg)$/i;

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function buildAnchor(startRaw: string | undefined, endRaw: string | undefined): LineAnchor | undefined {
  const startLine = parsePositiveInt(startRaw);
  if (startLine === undefined) {
    return undefined;
  }
  const endLine = parsePositiveInt(endRaw);
  if (endLine !== undefined && endLine >= startLine) {
    return { startLine, endLine };
  }
  return { startLine };
}

function parseDestination(rawDestination: string): {
  kind: "file" | "external-url";
  rawTarget: string;
  anchor?: LineAnchor;
} | null {
  let dest = rawDestination.trim();
  if (!dest) {
    return null;
  }

  // Handle angle-bracketed Markdown link destinations: [label](<path with spaces.ts#L1-L2>)
  if (dest.startsWith("<")) {
    const closeIdx = dest.indexOf(">");
    if (closeIdx > 1) {
      dest = dest.slice(1, closeIdx).trim();
    } else {
      return null;
    }
  } else {
    // Strip optional Markdown link title: (path/to/file.ts "Title") or ('Title')
    const titleMatch = /^(\S+)\s+(?:"[^"]*"|'[^']*')$/.exec(dest);
    if (titleMatch) {
      dest = titleMatch[1]!;
    }
  }

  if (!dest || dest.startsWith("#")) {
    return null;
  }

  if (BLOCKED_SCHEMES_RE.test(dest)) {
    return null;
  }

  if (EXTERNAL_URL_RE.test(dest)) {
    return { kind: "external-url", rawTarget: dest };
  }

  const hashMatch = HASH_LINE_ANCHOR_RE.exec(dest);
  if (hashMatch && hashMatch[1]) {
    const anchor = buildAnchor(hashMatch[2], hashMatch[3]);
    if (anchor) {
      return { kind: "file", rawTarget: hashMatch[1], anchor };
    }
  }

  const colonMatch = COLON_LINE_ANCHOR_RE.exec(dest);
  if (colonMatch && colonMatch[1]) {
    const anchor = buildAnchor(colonMatch[2], colonMatch[3]);
    if (anchor) {
      return { kind: "file", rawTarget: colonMatch[1], anchor };
    }
  }

  return { kind: "file", rawTarget: dest };
}

function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ");
}

/**
 * Extracts clickable local file references and external URLs from untrusted assistant
 * reply text into inert ChatLinkItem descriptors while preserving line anchors.
 */
export function parseReplyLinks(text: string, messageId: string): ChatLinkItem[] {
  if (!text || !text.trim()) {
    return [];
  }

  const sanitizedForScan = stripFencedCodeBlocks(text);
  const links: ChatLinkItem[] = [];
  const seen = new Set<string>();

  const pushUnique = (
    label: string,
    parsed: { kind: "file" | "external-url"; rawTarget: string; anchor?: LineAnchor },
  ): void => {
    const key = `${parsed.kind}|${parsed.rawTarget}|${parsed.anchor?.startLine ?? ""}|${parsed.anchor?.endLine ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    links.push({
      id: `${messageId}-link-${links.length}`,
      label: label.trim() || parsed.rawTarget,
      rawTarget: parsed.rawTarget,
      anchor: parsed.anchor,
      kind: parsed.kind,
    });
  };

  // 1. Markdown links: [label](destination) — skip image syntax ![alt](src)
  const markdownLinkRe =
    /(?<!!)\[([^\]\r\n]+)\]\((<[^>\r\n]+>|[^()\r\n]+(?:\([^()\r\n]*\)[^()\r\n]*)*)\)/g;
  const withoutMarkdownLinks = sanitizedForScan.replace(
    markdownLinkRe,
    (fullMatch, rawLabel: string, rawDest: string) => {
      const parsed = parseDestination(rawDest);
      if (parsed) {
        // Strip backticks around label for clean chip text, e.g. [`foo.ts`](foo.ts)
        const cleanLabel = rawLabel.trim().replace(/^`([^`]+)`$/, "$1");
        pushUnique(cleanLabel, parsed);
        return " ";
      }
      return fullMatch;
    },
  );

  // 2. Inline code file references with recognized extensions: `src/hello.ts#L5-L10`, `README.md`
  const inlineCodeRe = /`([^`\r\n\s]+)`/g;
  for (const match of withoutMarkdownLinks.matchAll(inlineCodeRe)) {
    const token = match[1]?.trim();
    if (!token || EXTERNAL_URL_RE.test(token) || BLOCKED_SCHEMES_RE.test(token)) {
      continue;
    }
    const parsed = parseDestination(token);
    if (!parsed || parsed.kind !== "file") {
      continue;
    }
    if (!RECOGNIZED_EXT_RE.test(parsed.rawTarget)) {
      continue;
    }
    pushUnique(token, parsed);
  }

  return links;
}

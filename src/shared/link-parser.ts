import type { ChatLinkItem, LineAnchor } from "./contracts";

const BLOCKED_SCHEMES_RE = /^(?:javascript|vbscript|data|mailto|tel|blob|about):/i;
const EXTERNAL_URL_RE = /^https?:\/\//i;
const FILE_URI_RE = /^file:/i;
const HASH_LINE_ANCHOR_RE = /^(.*)#L(\d+)(?:-L?(\d+))?$/i;
const COLON_LINE_ANCHOR_RE = /^(.*\.[a-zA-Z0-9_-]+):(\d+)(?:-(\d+))?$/;

const SINGLE_TOKEN_SHELL_CHAIN_RE = /[\x00-\x1f;<>|]|&&|\|\|/;
const MULTIWORD_SHELL_SYNTAX_RE = /[\x00-\x1f;<>|=$"']|&&|\|\|/;
const MULTIWORD_CLI_FLAG_RE = /(?:^|\s)--?[a-zA-Z0-9]/;
const EXPLICIT_PATH_PREFIX_RE = /^(?:\.\.?[\\/]|\/|~\/|file:\/\/|[a-zA-Z]:[\\/])/i;
const EXECUTABLE_OR_FILE_ARG_EXT_RE =
  /\.(?:exe|cmd|bat|ps1|sh|bash|zsh|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|json|yml|yaml|toml|md|txt|html|htm|css|pdf|sql|xml|csv)$/i;

const KNOWN_CLI_COMMANDS = new Set([
  "cat",
  "type",
  "less",
  "more",
  "head",
  "tail",
  "bat",
  "open",
  "start",
  "code",
  "vim",
  "nvim",
  "nano",
  "emacs",
  "notepad",
  "edit",
  "view",
  "rm",
  "del",
  "cp",
  "copy",
  "mv",
  "move",
  "ren",
  "mkdir",
  "rmdir",
  "touch",
  "ls",
  "dir",
  "tree",
  "find",
  "fd",
  "rg",
  "grep",
  "ag",
  "sed",
  "awk",
  "wc",
  "sort",
  "uniq",
  "diff",
  "patch",
  "chmod",
  "chown",
  "ln",
  "cd",
  "pwd",
  "echo",
  "printf",
  "git",
  "gh",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "node",
  "deno",
  "tsx",
  "ts-node",
  "vitest",
  "jest",
  "playwright",
  "eslint",
  "prettier",
  "tsc",
  "python",
  "python3",
  "pip",
  "pip3",
  "uv",
  "pytest",
  "cargo",
  "rustc",
  "go",
  "java",
  "javac",
  "dotnet",
  "pwsh",
  "powershell",
  "cmd",
  "bash",
  "sh",
  "zsh",
  "wsl",
  "curl",
  "wget",
  "docker",
  "kubectl",
  "make",
  "cmake",
  "omp",
  "run",
  "check",
  "inspect",
  "read",
  "see",
]);

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

function unescapeMarkdownDestination(dest: string): string {
  // Preserve native Windows separators (e.g. `docs\(draft).md`). Only unescape Markdown
  // backslash-escaped parentheses when `\)` appears.
  if (!dest.includes("\\)")) {
    return dest;
  }
  return dest.replace(/\\([()])/g, "$1");
}

function decodeMarkdownFileTargetOnce(target: string): string {
  // Leave file:// URI decoding to the main-process resolver (unwrapFileUriIfPresent)
  // so percent-encoding is never decoded twice.
  if (FILE_URI_RE.test(target) || !target.includes("%")) {
    return target;
  }
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function parseDestination(
  rawDestination: string,
  fromMarkdownLink: boolean,
): {
  kind: "file" | "external-url";
  rawTarget: string;
  anchor?: LineAnchor;
} | null {
  let dest = rawDestination.trim();
  if (!dest || dest.startsWith("#")) {
    return null;
  }

  if (fromMarkdownLink) {
    dest = unescapeMarkdownDestination(dest);
  }

  if (BLOCKED_SCHEMES_RE.test(dest)) {
    return null;
  }

  if (EXTERNAL_URL_RE.test(dest)) {
    return { kind: "external-url", rawTarget: dest };
  }

  let rawTarget = dest;
  let anchor: LineAnchor | undefined;

  const hashMatch = HASH_LINE_ANCHOR_RE.exec(dest);
  if (hashMatch && hashMatch[1]) {
    const parsedAnchor = buildAnchor(hashMatch[2], hashMatch[3]);
    if (parsedAnchor) {
      rawTarget = hashMatch[1];
      anchor = parsedAnchor;
    }
  } else {
    const colonMatch = COLON_LINE_ANCHOR_RE.exec(dest);
    if (colonMatch && colonMatch[1]) {
      const parsedAnchor = buildAnchor(colonMatch[2], colonMatch[3]);
      if (parsedAnchor) {
        rawTarget = colonMatch[1];
        anchor = parsedAnchor;
      }
    }
  }

  if (fromMarkdownLink) {
    rawTarget = decodeMarkdownFileTargetOnce(rawTarget);
  }

  if (!rawTarget || BLOCKED_SCHEMES_RE.test(rawTarget)) {
    return null;
  }

  return { kind: "file", rawTarget, anchor };
}

function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ");
}

function looksLikeCommandSpan(multiwordToken: string): boolean {
  if (MULTIWORD_SHELL_SYNTAX_RE.test(multiwordToken) || MULTIWORD_CLI_FLAG_RE.test(multiwordToken)) {
    return true;
  }
  const parts = multiwordToken.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return false;
  }
  const firstWord = parts[0]!;
  // If the first whitespace-separated token is a bare command name (no path separators),
  // e.g. `cat README.md`, `git status`, `node build.mjs`, treat it as a shell command.
  if (!firstWord.includes("/") && !firstWord.includes("\\")) {
    if (KNOWN_CLI_COMMANDS.has(firstWord.toLowerCase())) {
      return true;
    }
  }
  // If an earlier token already looks like an executable or separate file argument
  // (e.g. `./run.sh README.md`, `node.exe app.js`, `diff a.ts b.ts`), treat as a multi-arg command.
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (EXECUTABLE_OR_FILE_ARG_EXT_RE.test(parts[i]!)) {
      return true;
    }
  }
  return false;
}

function isPlausibleSpacedBareMarkdownPath(rawTarget: string): boolean {
  if (looksLikeCommandSpan(rawTarget)) {
    return false;
  }
  return RECOGNIZED_EXT_RE.test(rawTarget) || EXPLICIT_PATH_PREFIX_RE.test(rawTarget);
}

interface ScannedMarkdownLink {
  start: number;
  end: number;
  label: string;
  destination: string;
  angleBracketed: boolean;
}

/**
 * Linear-time single-line Markdown link scanner that handles angle-bracketed destinations,
 * optional quoted titles, unquoted spaced local file paths, Windows separators before
 * parenthesized filenames (`docs\(draft).md`), and nested balanced parentheses.
 */
function scanMarkdownLinks(text: string): ScannedMarkdownLink[] {
  const results: ScannedMarkdownLink[] = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    if (text[i] !== "[") {
      i += 1;
      continue;
    }
    // Skip image links ![alt](src)
    if (i > 0 && text[i - 1] === "!") {
      i += 1;
      continue;
    }

    // Find matching closing ']' on the same line (tracking nested '[' / ']')
    let labelEnd = -1;
    let bracketDepth = 1;
    for (let j = i + 1; j < len; j += 1) {
      const ch = text[j]!;
      if (ch === "\r" || ch === "\n") {
        break;
      }
      if (ch === "\\" && j + 1 < len) {
        j += 1;
        continue;
      }
      if (ch === "[") {
        bracketDepth += 1;
      } else if (ch === "]") {
        bracketDepth -= 1;
        if (bracketDepth === 0) {
          labelEnd = j;
          break;
        }
      }
    }

    if (labelEnd === -1 || labelEnd === i + 1 || text[labelEnd + 1] !== "(") {
      i += 1;
      continue;
    }

    const label = text.slice(i + 1, labelEnd);
    let pos = labelEnd + 2;
    while (pos < len && (text[pos] === " " || text[pos] === "\t")) {
      pos += 1;
    }

    let destination: string | null = null;
    let closeParenIdx = -1;
    let angleBracketed = false;

    if (pos < len && text[pos] === "<") {
      angleBracketed = true;
      const gtIdx = text.indexOf(">", pos + 1);
      if (gtIdx !== -1) {
        const inner = text.slice(pos + 1, gtIdx);
        if (!inner.includes("\r") && !inner.includes("\n")) {
          const tailEnd = parseOptionalTitleAndCloseParen(text, gtIdx + 1);
          if (tailEnd !== -1) {
            destination = inner;
            closeParenIdx = tailEnd;
          }
        }
      }
    } else {
      const destStart = pos;
      let parenDepth = 0;
      let seenWhitespace = false;
      const lineEndIdx = (() => {
        const lf = text.indexOf("\n", destStart);
        const cr = text.indexOf("\r", destStart);
        if (lf === -1) return cr === -1 ? len : cr;
        if (cr === -1) return lf;
        return Math.min(lf, cr);
      })();

      while (pos < lineEndIdx) {
        const ch = text[pos]!;
        // Handle Markdown-escaped closing paren `\)` at depth 0 when another `)` exists later on the line,
        // without consuming Windows path separators like `docs\(draft).md` before `(`.
        if (
          ch === "\\" &&
          pos + 1 < lineEndIdx &&
          text[pos + 1] === ")" &&
          parenDepth === 0 &&
          text.indexOf(")", pos + 2) !== -1 &&
          text.indexOf(")", pos + 2) < lineEndIdx
        ) {
          pos += 2;
          continue;
        }
        if (ch === "(") {
          parenDepth += 1;
          pos += 1;
          continue;
        }
        if (ch === ")") {
          if (parenDepth === 0) {
            destination = text.slice(destStart, pos);
            closeParenIdx = pos;
            break;
          }
          parenDepth -= 1;
          pos += 1;
          continue;
        }
        if ((ch === " " || ch === "\t") && parenDepth === 0) {
          const tailEnd = parseOptionalTitleAndCloseParen(text, pos);
          if (tailEnd !== -1) {
            destination = text.slice(destStart, pos);
            closeParenIdx = tailEnd;
            break;
          }
          // External web URLs never contain raw unencoded spaces; abort instead of swallowing prose
          const prefixSoFar = text.slice(destStart, pos);
          if (EXTERNAL_URL_RE.test(prefixSoFar)) {
            break;
          }
          seenWhitespace = true;
          pos += 1;
          continue;
        }
        if (ch === "[" && seenWhitespace && parenDepth === 0) {
          // Do not swallow a subsequent Markdown link on the same line inside prose
          break;
        }
        pos += 1;
      }
    }

    if (destination !== null && destination.trim().length > 0 && closeParenIdx !== -1) {
      results.push({
        start: i,
        end: closeParenIdx + 1,
        label,
        destination,
        angleBracketed,
      });
      i = closeParenIdx + 1;
    } else {
      i += 1;
    }
  }

  return results;
}

/**
 * Parses optional whitespace + optional Markdown link title ("..." or '...') + optional whitespace + ')'.
 * Returns the index of the closing ')' or -1 if invalid.
 */
function parseOptionalTitleAndCloseParen(text: string, start: number): number {
  const len = text.length;
  let p = start;
  while (p < len && (text[p] === " " || text[p] === "\t")) {
    p += 1;
  }
  if (p < len && text[p] === ")") {
    return p;
  }
  if (p < len && (text[p] === '"' || text[p] === "'")) {
    const quote = text[p]!;
    p += 1;
    while (p < len) {
      const ch = text[p]!;
      if (ch === "\r" || ch === "\n") {
        return -1;
      }
      if (ch === "\\" && p + 1 < len) {
        p += 2;
        continue;
      }
      if (ch === quote) {
        p += 1;
        break;
      }
      p += 1;
    }
    while (p < len && (text[p] === " " || text[p] === "\t")) {
      p += 1;
    }
    if (p < len && text[p] === ")") {
      return p;
    }
  }
  return -1;
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

  // 1. Markdown links scanned via balanced-parenthesis tokenizer
  const scannedLinks = scanMarkdownLinks(sanitizedForScan);
  const chunks: string[] = [];
  let cursor = 0;

  for (const item of scannedLinks) {
    const parsed = parseDestination(item.destination, true);
    if (!parsed) {
      continue;
    }
    // For bare (non-angle-bracketed) destinations containing literal spaces, verify it looks
    // like a local path rather than prose inside parentheses (e.g. `[note](see above)`).
    if (
      !item.angleBracketed &&
      /\s/.test(item.destination.trim()) &&
      (parsed.kind !== "file" || !isPlausibleSpacedBareMarkdownPath(parsed.rawTarget))
    ) {
      continue;
    }
    const cleanLabel = item.label.trim().replace(/^`([^`]+)`$/, "$1");
    pushUnique(cleanLabel, parsed);
    chunks.push(sanitizedForScan.slice(cursor, item.start), " ");
    cursor = item.end;
  }
  chunks.push(sanitizedForScan.slice(cursor));
  const withoutMarkdownLinks = chunks.join("");

  // 2. Single-line inline code file references (supporting spaced paths & legal punctuation,
  //    while filtering out multi-word shell commands like `cat README.md`)
  const inlineCodeRe = /`([^`\r\n]+)`/g;
  for (const match of withoutMarkdownLinks.matchAll(inlineCodeRe)) {
    const token = match[1]?.trim();
    if (!token || EXTERNAL_URL_RE.test(token) || BLOCKED_SCHEMES_RE.test(token)) {
      continue;
    }
    const hasWhitespace = /\s/.test(token);
    if (hasWhitespace) {
      if (looksLikeCommandSpan(token)) {
        continue;
      }
    } else if (SINGLE_TOKEN_SHELL_CHAIN_RE.test(token)) {
      continue;
    }

    const parsed = parseDestination(token, false);
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

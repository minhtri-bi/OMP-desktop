import fs from "node:fs";
import path from "node:path";
import type {
  BreadcrumbSegment,
  ChatWorkspaceBinding,
  MessageFileLinkRequest,
  PathResolutionErrorCode,
  PathResolutionResult,
  PreviewViewerKind,
  ResolvedPreviewDescriptor,
} from "../shared/contracts";

const RESERVED_DOS_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]+:/;
const DRIVE_RELATIVE_RE = /^[a-zA-Z]:(?![\\/])/;

export function stripWin32ExtendedPrefix(input: string): string {
  if (input.startsWith("\\\\?\\UNC\\")) {
    return "\\\\" + input.slice("\\\\?\\UNC\\".length);
  }
  if (input.startsWith("\\\\?\\")) {
    return input.slice("\\\\?\\".length);
  }
  return input;
}

export function normalizeForComparison(input: string): string {
  const cleaned = stripWin32ExtendedPrefix(input).replace(/\\/g, "/");
  // Trim trailing slashes except root "/" or Windows drive root "c:/"
  const trimmed = cleaned.replace(/\/+$/, "");
  if (trimmed === "") {
    return "/";
  }
  if (/^[a-zA-Z]:$/.test(trimmed)) {
    return `${trimmed.toLowerCase()}/`;
  }
  return trimmed.toLowerCase();
}

export function isPathWithinRoot(canonicalTarget: string, canonicalRoot: string): boolean {
  const normRoot = normalizeForComparison(canonicalRoot);
  const normTarget = normalizeForComparison(canonicalTarget);
  if (normTarget === normRoot) {
    return true;
  }
  const prefix = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;
  return normTarget.startsWith(prefix);
}

export function canonicalizeExistingPath(targetPath: string): string {
  return stripWin32ExtendedPrefix(fs.realpathSync.native(targetPath));
}

function unwrapFileUriIfPresent(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  if (!/^file:/i.test(raw)) {
    return { ok: true, value: raw };
  }
  if (!/^file:\/\//i.test(raw)) {
    return { ok: false, reason: "Malformed file URI." };
  }
  const withoutScheme = raw.slice("file://".length);
  const firstSlash = withoutScheme.indexOf("/");
  if (firstSlash === -1) {
    return { ok: false, reason: "File URI is missing a path." };
  }
  const host = withoutScheme.slice(0, firstSlash);
  if (host !== "" && host.toLowerCase() !== "localhost") {
    return { ok: false, reason: "UNC or remote host in file URI is forbidden." };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutScheme.slice(firstSlash));
  } catch {
    return { ok: false, reason: "File URI contains invalid percent-encoding." };
  }
  // Convert /C:/path -> C:/path on Windows-style file:/// URIs
  if (/^\/[a-zA-Z]:[\\/]/.test(decoded)) {
    decoded = decoded.slice(1);
  }
  return { ok: true, value: decoded };
}

export function validatePathSyntax(rawTarget: string): { ok: true; cleanedTarget: string } | { ok: false; reason: string } {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    return { ok: false, reason: "Path is empty." };
  }
  if (/[\x00-\x1f]/.test(trimmed)) {
    return { ok: false, reason: "Path contains control or NUL characters." };
  }

  const unwrapped = unwrapFileUriIfPresent(trimmed);
  if (!unwrapped.ok) {
    return unwrapped;
  }
  const candidate = unwrapped.value;

  if (/[\x00-\x1f]/.test(candidate)) {
    return { ok: false, reason: "Decoded path contains control or NUL characters." };
  }

  // Reject Win32 extended/device prefixes and UNC paths before touching filesystem
  if (candidate.startsWith("\\\\") || candidate.startsWith("//")) {
    return { ok: false, reason: "UNC, extended, and device paths are blocked." };
  }

  // Reject any URI scheme (file: already unwrapped; single-letter drive C: has length 1 before colon)
  if (URI_SCHEME_RE.test(candidate)) {
    return { ok: false, reason: "URI scheme is not permitted for local file resolution." };
  }

  // Reject drive-relative paths such as C:foo.txt or \foo.txt
  if (DRIVE_RELATIVE_RE.test(candidate) || candidate.startsWith("\\")) {
    return { ok: false, reason: "Drive-relative paths are blocked." };
  }

  // Reject NTFS Alternate Data Streams (any colon other than index 1 Windows drive letter)
  for (let i = 0; i < candidate.length; i += 1) {
    if (candidate[i] === ":") {
      if (!(i === 1 && /^[a-zA-Z]$/.test(candidate[0] ?? ""))) {
        return { ok: false, reason: "Alternate Data Stream syntax is blocked." };
      }
    }
  }

  // Reject Windows reserved DOS device names in any path component
  const segments = candidate.split(/[\\/]+/).filter(Boolean);
  for (const seg of segments) {
    // Skip drive specifier segment like "C:"
    if (/^[a-zA-Z]:$/.test(seg)) {
      continue;
    }
    const stripped = seg.replace(/[. ]+$/, "");
    const baseName = stripped.split(".")[0] ?? "";
    if (RESERVED_DOS_NAME_RE.test(baseName)) {
      return { ok: false, reason: `Reserved Windows device name "${seg}" is blocked.` };
    }
  }

  return { ok: true, cleanedTarget: candidate };
}

function fail(
  code: PathResolutionErrorCode,
  message: string,
  displayTarget: string,
): PathResolutionResult {
  return { ok: false, code, message, displayTarget };
}

function classifyViewer(
  canonicalPath: string,
  isDirectory: boolean,
  preferSourceView?: boolean,
): PreviewViewerKind {
  if (isDirectory) {
    return "folder-explorer";
  }
  const ext = path.extname(canonicalPath).toLowerCase();
  if (ext === ".pdf") {
    return "pdf";
  }
  if ((ext === ".html" || ext === ".htm") && !preferSourceView) {
    return "html-isolated-browser";
  }
  return "source";
}

function buildProjectBreadcrumbs(
  workspaceDisplayName: string,
  relativePosixPath: string,
  isDirectory: boolean,
): BreadcrumbSegment[] {
  const segments: BreadcrumbSegment[] = [
    { label: workspaceDisplayName, browsableRelativePath: "" },
  ];
  if (!relativePosixPath || relativePosixPath === ".") {
    return segments;
  }
  const parts = relativePosixPath.split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const rel = parts.slice(0, i + 1).join("/");
    const isLast = i === parts.length - 1;
    segments.push({
      label: part,
      browsableRelativePath: !isLast || isDirectory ? rel : null,
    });
  }
  return segments;
}

export function buildPreviewTabKey(
  owningBinding: ChatWorkspaceBinding,
  canonicalPath: string,
  preferSourceView?: boolean,
): string {
  const normLower = normalizeForComparison(canonicalPath);
  const baseKey =
    owningBinding.kind === "project"
      ? `file:${owningBinding.workspaceId}:${normLower}`
      : `standalone-file:${owningBinding.chatId}:${normLower}`;
  return preferSourceView ? `source:${baseKey}` : baseKey;
}

export function isAbsolutePathCrossPlatform(p: string): boolean {
  return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p);
}

export function resolveMessageFileLink(request: MessageFileLinkRequest): PathResolutionResult {
  const displayTarget = request.rawTarget.trim() || "(empty path)";
  const syntax = validatePathSyntax(request.rawTarget);
  if (!syntax.ok) {
    return fail("UNSAFE_PATH_SYNTAX", syntax.reason, displayTarget);
  }

  const cleaned = syntax.cleanedTarget;

  if (request.owningBinding.kind === "standalone") {
    if (!isAbsolutePathCrossPlatform(cleaned)) {
      return fail(
        "UNATTACHED_STANDALONE_PATH",
        "Standalone chats can only open explicitly attached files, not relative or arbitrary paths.",
        displayTarget,
      );
    }

    const allowlist = new Set(
      request.owningBinding.attachedCanonicalPaths.map((p) => normalizeForComparison(p)),
    );
    const normalizedCandidate = normalizeForComparison(path.resolve(cleaned));
    if (!allowlist.has(normalizedCandidate)) {
      return fail(
        "UNATTACHED_STANDALONE_PATH",
        "This file is not attached to the active standalone chat.",
        displayTarget,
      );
    }

    if (!fs.existsSync(cleaned)) {
      return fail(
        request.isRestoredMessage ? "STALE_LINK" : "MISSING_FILE",
        request.isRestoredMessage
          ? "Attached file from restored chat is no longer available."
          : "Attached file could not be found.",
        displayTarget,
      );
    }

    let canonicalTarget: string;
    let stat: fs.Stats;
    try {
      canonicalTarget = canonicalizeExistingPath(cleaned);
      stat = fs.statSync(canonicalTarget);
    } catch {
      return fail(
        request.isRestoredMessage ? "STALE_LINK" : "MISSING_FILE",
        "Attached file could not be accessed.",
        displayTarget,
      );
    }

    if (!allowlist.has(normalizeForComparison(canonicalTarget))) {
      return fail(
        "UNATTACHED_STANDALONE_PATH",
        "Attached path now resolves outside the explicit standalone attachment allowlist.",
        displayTarget,
      );
    }
    if (stat.isDirectory()) {
      return fail(
        "UNATTACHED_STANDALONE_PATH",
        "Standalone chats cannot browse folders; open the folder as a project instead.",
        displayTarget,
      );
    }

    const baseName = path.basename(canonicalTarget);
    const viewerKind = classifyViewer(canonicalTarget, false, request.preferSourceView);
    const descriptor: ResolvedPreviewDescriptor = {
      tabKey: buildPreviewTabKey(request.owningBinding, canonicalTarget, request.preferSourceView),
      viewerKind,
      canonicalPath: canonicalTarget,
      displayPath: baseName,
      breadcrumbs: [
        { label: "Attached", browsableRelativePath: null },
        { label: baseName, browsableRelativePath: null },
      ],
      parentBrowsingAllowed: false,
      anchor: request.anchor,
    };
    return { ok: true, descriptor };
  }

  // Project workspace binding
  const { workspaceRoot, workspaceDisplayName } = request.owningBinding;
  if (!fs.existsSync(workspaceRoot)) {
    return fail(
      "WORKSPACE_UNAVAILABLE",
      `Owning workspace "${workspaceDisplayName}" is no longer available on disk.`,
      displayTarget,
    );
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = canonicalizeExistingPath(workspaceRoot);
  } catch {
    return fail(
      "WORKSPACE_UNAVAILABLE",
      `Owning workspace "${workspaceDisplayName}" could not be canonicalized.`,
      displayTarget,
    );
  }

  // Normalize Windows backslashes so relative paths work identically on Linux and Windows tests
  const platformRelative = cleaned.replace(/\\/g, path.sep);
  const candidatePath = isAbsolutePathCrossPlatform(cleaned)
    ? cleaned
    : path.resolve(canonicalRoot, platformRelative);

  // Check syntactic escape BEFORE checking existence so out-of-workspace non-existent paths return OUT_OF_WORKSPACE
  if (!isPathWithinRoot(candidatePath, canonicalRoot)) {
    return fail(
      "OUT_OF_WORKSPACE",
      `Path escapes owning workspace "${workspaceDisplayName}".`,
      displayTarget,
    );
  }

  if (!fs.existsSync(candidatePath)) {
    return fail(
      request.isRestoredMessage ? "STALE_LINK" : "MISSING_FILE",
      request.isRestoredMessage
        ? `Stale link: "${displayTarget}" no longer exists in "${workspaceDisplayName}".`
        : `File not found: "${displayTarget}" does not exist in "${workspaceDisplayName}".`,
      displayTarget,
    );
  }

  let canonicalTarget: string;
  let stat: fs.Stats;
  try {
    canonicalTarget = canonicalizeExistingPath(candidatePath);
    stat = fs.statSync(canonicalTarget);
  } catch {
    return fail(
      request.isRestoredMessage ? "STALE_LINK" : "MISSING_FILE",
      `Target "${displayTarget}" could not be resolved.`,
      displayTarget,
    );
  }

  // Re-verify containment AFTER realpath to block NTFS symlinks, directory junctions, and mount points
  if (!isPathWithinRoot(canonicalTarget, canonicalRoot)) {
    return fail(
      "OUT_OF_WORKSPACE",
      `Resolved target escapes owning workspace "${workspaceDisplayName}" (symlink or junction blocked).`,
      displayTarget,
    );
  }

  const relativePosix = path.relative(canonicalRoot, canonicalTarget).replace(/\\/g, "/");
  const isDirectory = stat.isDirectory();
  const viewerKind = classifyViewer(canonicalTarget, isDirectory, request.preferSourceView);

  const descriptor: ResolvedPreviewDescriptor = {
    tabKey: buildPreviewTabKey(request.owningBinding, canonicalTarget, request.preferSourceView),
    viewerKind,
    canonicalPath: canonicalTarget,
    displayPath: relativePosix || workspaceDisplayName,
    breadcrumbs: buildProjectBreadcrumbs(workspaceDisplayName, relativePosix, isDirectory),
    parentBrowsingAllowed: true,
    anchor: request.anchor,
  };

  return { ok: true, descriptor };
}

export function resolvePreviewSubresource(
  canonicalScopeRoot: string,
  relativeUrlPath: string,
  singleFileOnlyCanonicalPath?: string,
): { ok: true; canonicalPath: string } | { ok: false; statusCode: 403 | 404; reason: string } {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(relativeUrlPath);
  } catch {
    return { ok: false, statusCode: 403, reason: "Invalid URL encoding." };
  }

  const trimmed = decodedPath.replace(/^\/+/, "");
  const syntax = validatePathSyntax(trimmed);
  if (!syntax.ok) {
    return { ok: false, statusCode: 403, reason: syntax.reason };
  }

  if (singleFileOnlyCanonicalPath) {
    const allowedName = path.basename(singleFileOnlyCanonicalPath);
    if (normalizeForComparison(trimmed) !== normalizeForComparison(allowedName)) {
      return {
        ok: false,
        statusCode: 403,
        reason: "Standalone preview cannot access sibling files.",
      };
    }
    if (!fs.existsSync(singleFileOnlyCanonicalPath)) {
      return { ok: false, statusCode: 404, reason: "Attached preview file missing." };
    }
    const real = canonicalizeExistingPath(singleFileOnlyCanonicalPath);
    if (normalizeForComparison(real) !== normalizeForComparison(singleFileOnlyCanonicalPath)) {
      return { ok: false, statusCode: 403, reason: "Standalone preview realpath mismatch." };
    }
    return { ok: true, canonicalPath: real };
  }

  const candidate = path.resolve(canonicalScopeRoot, syntax.cleanedTarget.replace(/\\/g, path.sep));
  if (!isPathWithinRoot(candidate, canonicalScopeRoot)) {
    return { ok: false, statusCode: 403, reason: "Subresource escapes workspace root." };
  }
  if (!fs.existsSync(candidate)) {
    return { ok: false, statusCode: 404, reason: "Subresource not found." };
  }
  let real: string;
  try {
    real = canonicalizeExistingPath(candidate);
  } catch {
    return { ok: false, statusCode: 404, reason: "Subresource unreadable." };
  }
  if (!isPathWithinRoot(real, canonicalScopeRoot)) {
    return { ok: false, statusCode: 403, reason: "Subresource symlink escapes workspace root." };
  }
  return { ok: true, canonicalPath: real };
}

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
const MAX_SYMLINK_DEPTH = 32;

export function stripWin32ExtendedPrefix(input: string): string {
  if (input.startsWith("\\\\?\\UNC\\")) {
    return "\\\\" + input.slice("\\\\?\\UNC\\".length);
  }
  if (input.startsWith("\\\\?\\")) {
    return input.slice("\\\\?\\".length);
  }
  return input;
}

function isWindowsStylePath(input: string): boolean {
  return process.platform === "win32" || /^[a-zA-Z]:[\\/]/.test(input) || /^[a-zA-Z]:$/.test(input);
}

export function normalizePathSlashes(input: string): string {
  const cleaned = stripWin32ExtendedPrefix(input);
  // Security: on POSIX, backslash is a legal filename character, NOT a path separator.
  // Only convert backslashes on Windows or explicit Windows drive paths.
  const normalizedSep = isWindowsStylePath(cleaned) ? cleaned.replace(/\\/g, "/") : cleaned;
  const trimmed = normalizedSep.replace(/\/+$/, "");
  if (trimmed === "") {
    return "/";
  }
  if (/^[a-zA-Z]:$/.test(trimmed)) {
    return `${trimmed.toUpperCase()}/`;
  }
  // Normalize Windows drive letter casing (e.g., c:/ -> C:/) without folding directory names
  if (/^[a-zA-Z]:\//.test(trimmed)) {
    return `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}`;
  }
  return trimmed;
}

export function normalizeForComparison(
  input: string,
  caseInsensitive = process.platform === "win32",
): string {
  const normalized = normalizePathSlashes(input);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/**
 * Verifies containment using exact case on canonicalized paths by default so
 * case-sensitive filesystems (Linux, or NTFS per-directory case-sensitive dirs)
 * cannot be bypassed by case-folding. Pass `caseInsensitive: true` only for
 * pre-canonicalization syntactic matching on Windows.
 */
export function isPathWithinRoot(
  canonicalTarget: string,
  canonicalRoot: string,
  caseInsensitive = false,
): boolean {
  const normRoot = normalizeForComparison(canonicalRoot, caseInsensitive);
  const normTarget = normalizeForComparison(canonicalTarget, caseInsensitive);
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

type SafeWalkResult =
  | { ok: true; canonicalPath: string; stat: fs.Stats }
  | { ok: false; code: "UNSAFE_PATH_SYNTAX" | "OUT_OF_WORKSPACE" | "MISSING"; reason: string };

/**
 * Verifies that a differently-cased Windows prefix actually identifies the exact same
 * directory as `canonicalRoot` (preventing case-sensitive NTFS sibling rebasing).
 */
function verifyWindowsPrefixMatchesRoot(candidatePrefix: string, canonicalRoot: string): boolean {
  const normRoot = normalizePathSlashes(canonicalRoot);
  const normPrefix = normalizePathSlashes(candidatePrefix);
  if (normPrefix === normRoot) {
    return true;
  }
  if (process.platform !== "win32") {
    return false;
  }
  // Walk each segment of candidatePrefix from the drive root using lstatSync so we
  // never follow an unverified symlink/junction anywhere along a differently-cased prefix.
  try {
    const driveMatch = /^([a-zA-Z]:)\/(.*)$/.exec(normPrefix);
    if (!driveMatch) {
      return false;
    }
    let cur = `${driveMatch[1]}\\`;
    const parts = driveMatch[2] ? driveMatch[2].split("/").filter(Boolean) : [];
    for (const part of parts) {
      cur = path.join(cur, part);
      const ls = fs.lstatSync(cur);
      if (ls.isSymbolicLink()) {
        return false;
      }
    }
    const realPrefix = canonicalizeExistingPath(candidatePrefix);
    return normalizePathSlashes(realPrefix) === normRoot;
  } catch {
    return false;
  }
}

/**
 * Walks path segments starting from `canonicalRoot` using `lstatSync` and `readlinkSync`
 * before ever calling `realpathSync` or `statSync`. This guarantees symlinks/junctions
 * pointing to UNC shares (`\\server\share`) or outside directories are rejected locally
 * without Windows ever attempting SMB/NTLM network authentication.
 */
function safeWalkWithinCanonicalRoot(
  canonicalRoot: string,
  candidatePath: string,
  depth = 0,
): SafeWalkResult {
  if (depth > MAX_SYMLINK_DEPTH) {
    return { ok: false, code: "OUT_OF_WORKSPACE", reason: "Exceeded maximum symlink depth." };
  }

  // Re-verify that the registered root itself has not been replaced with a symlink to another directory
  let currentRootCanonical: string;
  try {
    const rootLstat = fs.lstatSync(canonicalRoot);
    if (rootLstat.isSymbolicLink()) {
      return {
        ok: false,
        code: "OUT_OF_WORKSPACE",
        reason: "Owning workspace root was replaced with a symlink.",
      };
    }
    currentRootCanonical = canonicalizeExistingPath(canonicalRoot);
  } catch {
    return { ok: false, code: "OUT_OF_WORKSPACE", reason: "Owning workspace root is unavailable." };
  }
  if (normalizePathSlashes(currentRootCanonical) !== normalizePathSlashes(canonicalRoot)) {
    return {
      ok: false,
      code: "OUT_OF_WORKSPACE",
      reason: "Owning workspace root changed on disk (possible symlink swap).",
    };
  }

  // Pre-check candidate containment (allow case-insensitive prefix only on Windows after verifying identity)
  if (!isPathWithinRoot(candidatePath, canonicalRoot, process.platform === "win32")) {
    return { ok: false, code: "OUT_OF_WORKSPACE", reason: "Path escapes owning workspace root." };
  }

  const normRoot = normalizePathSlashes(canonicalRoot);
  const normCandidate = normalizePathSlashes(candidatePath);
  const rootPrefix = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;

  let relativePart = "";
  if (normCandidate === normRoot) {
    relativePart = "";
  } else if (normCandidate.startsWith(rootPrefix)) {
    relativePart = normCandidate.slice(rootPrefix.length);
  } else if (process.platform === "win32") {
    const lowerRoot = normRoot.toLowerCase();
    const lowerCandidate = normCandidate.toLowerCase();
    const lowerPrefix = rootPrefix.toLowerCase();
    if (lowerCandidate === lowerRoot) {
      if (!verifyWindowsPrefixMatchesRoot(normCandidate, canonicalRoot)) {
        return {
          ok: false,
          code: "OUT_OF_WORKSPACE",
          reason: "Case-differing Windows path identifies a different directory.",
        };
      }
      relativePart = "";
    } else if (lowerCandidate.startsWith(lowerPrefix)) {
      const candidatePrefix = normCandidate.slice(0, normRoot.length);
      if (!verifyWindowsPrefixMatchesRoot(candidatePrefix, canonicalRoot)) {
        return {
          ok: false,
          code: "OUT_OF_WORKSPACE",
          reason: "Case-differing Windows path identifies a different directory.",
        };
      }
      relativePart = normCandidate.slice(rootPrefix.length);
    } else {
      return { ok: false, code: "OUT_OF_WORKSPACE", reason: "Path escapes owning workspace root." };
    }
  } else {
    return { ok: false, code: "OUT_OF_WORKSPACE", reason: "Path escapes owning workspace root." };
  }

  const segments = relativePart.split("/").filter(Boolean);
  let current = canonicalRoot;

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    const next = path.join(current, seg);

    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(next);
    } catch {
      return { ok: false, code: "MISSING", reason: "Target does not exist." };
    }

    if (lstat.isSymbolicLink()) {
      let rawLinkTarget: string;
      try {
        rawLinkTarget = fs.readlinkSync(next);
      } catch {
        return { ok: false, code: "OUT_OF_WORKSPACE", reason: "Unreadable symlink target." };
      }

      const strippedLink = stripWin32ExtendedPrefix(rawLinkTarget);
      // Validate dangerous symlink targets (UNC, device, NUL); note POSIX absolute symlinks may live in colon dirs,
      // so check UNC/device/control/ADS carefully without breaking legitimate POSIX workspace directories with colons.
      if (/[\x00-\x1f]/.test(strippedLink) || strippedLink.startsWith("\\\\") || strippedLink.startsWith("//")) {
        return {
          ok: false,
          code: "UNSAFE_PATH_SYNTAX",
          reason: "Blocked unsafe symlink target (UNC, extended, device, or control characters).",
        };
      }
      if (process.platform === "win32") {
        const linkSyntax = validatePathSyntax(strippedLink);
        if (!linkSyntax.ok) {
          return {
            ok: false,
            code: "UNSAFE_PATH_SYNTAX",
            reason: `Blocked unsafe symlink target: ${linkSyntax.reason}`,
          };
        }
      }

      const resolvedLinkTarget = isAbsolutePathCrossPlatform(strippedLink)
        ? strippedLink
        : path.resolve(current, process.platform === "win32" ? strippedLink.replace(/\\/g, path.sep) : strippedLink);

      const remaining = segments.slice(i + 1);
      const combinedTarget =
        remaining.length > 0 ? path.resolve(resolvedLinkTarget, ...remaining) : resolvedLinkTarget;

      // Reject escapes BEFORE walking or touching the outside destination
      if (!isPathWithinRoot(combinedTarget, canonicalRoot, process.platform === "win32")) {
        return {
          ok: false,
          code: "OUT_OF_WORKSPACE",
          reason: "Symlink or junction target escapes owning workspace root.",
        };
      }

      return safeWalkWithinCanonicalRoot(canonicalRoot, combinedTarget, depth + 1);
    }

    current = next;
  }

  let canonicalTarget: string;
  let finalStat: fs.Stats;
  try {
    canonicalTarget = canonicalizeExistingPath(current);
    finalStat = fs.statSync(canonicalTarget);
  } catch {
    return { ok: false, code: "MISSING", reason: "Target could not be canonicalized." };
  }

  // Strict case-sensitive containment on canonical realpaths prevents case-folding bypasses
  if (!isPathWithinRoot(canonicalTarget, canonicalRoot, false)) {
    return {
      ok: false,
      code: "OUT_OF_WORKSPACE",
      reason: "Canonical target escapes owning workspace root.",
    };
  }

  return { ok: true, canonicalPath: canonicalTarget, stat: finalStat };
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
  const normKey = normalizeForComparison(canonicalPath, true);
  const baseKey =
    owningBinding.kind === "project"
      ? `file:${owningBinding.workspaceId}:${normKey}`
      : `standalone-file:${owningBinding.chatId}:${normKey}`;
  return preferSourceView ? `source:${baseKey}` : baseKey;
}

export function isAbsolutePathCrossPlatform(p: string): boolean {
  return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p);
}

/**
 * Authorizes an already-resolved filesystem path (e.g. from readSourceFile / readPdfBytes)
 * without reparsing trusted root path segments (like POSIX folders containing colons) as raw link syntax.
 */
export function authorizeCanonicalReadPath(
  candidatePath: string,
  owningBinding: ChatWorkspaceBinding,
): string {
  if (!candidatePath || /[\x00-\x1f]/.test(candidatePath)) {
    throw new Error("Access denied: invalid file path.");
  }
  if (candidatePath.startsWith("\\\\") || candidatePath.startsWith("//")) {
    throw new Error("Access denied: UNC or device path is blocked.");
  }

  if (owningBinding.kind === "standalone") {
    const allowlist = new Set(
      owningBinding.attachedCanonicalPaths.map((p) =>
        normalizeForComparison(p, process.platform === "win32"),
      ),
    );
    const normalizedCandidate = normalizeForComparison(
      path.resolve(candidatePath),
      process.platform === "win32",
    );
    if (!allowlist.has(normalizedCandidate)) {
      throw new Error("Access denied: file is outside standalone chat attachments.");
    }
    const ls = fs.lstatSync(candidatePath);
    if (ls.isSymbolicLink()) {
      const target = stripWin32ExtendedPrefix(fs.readlinkSync(candidatePath));
      if (target.startsWith("\\\\") || target.startsWith("//")) {
        throw new Error("Access denied: unsafe symlink target.");
      }
    }
    const real = canonicalizeExistingPath(candidatePath);
    const exactAllowlist = new Set(
      owningBinding.attachedCanonicalPaths.map((p) => normalizePathSlashes(p)),
    );
    if (!exactAllowlist.has(normalizePathSlashes(real))) {
      throw new Error("Access denied: attached file resolved outside allowlist.");
    }
    if (fs.statSync(real).isDirectory()) {
      throw new Error("Access denied: target is a directory.");
    }
    return real;
  }

  const canonicalRoot = canonicalizeExistingPath(owningBinding.workspaceRoot);
  const walked = safeWalkWithinCanonicalRoot(canonicalRoot, candidatePath);
  if (!walked.ok) {
    throw new Error(`Access denied (${walked.code}): ${walked.reason}`);
  }
  if (walked.stat.isDirectory()) {
    throw new Error("Access denied: target is a directory.");
  }
  return walked.canonicalPath;
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
      request.owningBinding.attachedCanonicalPaths.map((p) =>
        normalizeForComparison(p, process.platform === "win32"),
      ),
    );
    const normalizedCandidate = normalizeForComparison(
      path.resolve(cleaned),
      process.platform === "win32",
    );
    if (!allowlist.has(normalizedCandidate)) {
      return fail(
        "UNATTACHED_STANDALONE_PATH",
        "This file is not attached to the active standalone chat.",
        displayTarget,
      );
    }

    // Check lstat first so a swapped symlink to a UNC share is rejected without contacting SMB
    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(cleaned);
    } catch {
      return fail(
        request.isRestoredMessage ? "STALE_LINK" : "MISSING_FILE",
        request.isRestoredMessage
          ? "Attached file from restored chat is no longer available."
          : "Attached file could not be found.",
        displayTarget,
      );
    }

    if (lstat.isSymbolicLink()) {
      let linkTarget: string;
      try {
        linkTarget = stripWin32ExtendedPrefix(fs.readlinkSync(cleaned));
      } catch {
        return fail("UNATTACHED_STANDALONE_PATH", "Attached symlink could not be read.", displayTarget);
      }
      if (linkTarget.startsWith("\\\\") || linkTarget.startsWith("//") || /[\x00-\x1f]/.test(linkTarget)) {
        return fail("UNSAFE_PATH_SYNTAX", "Blocked unsafe symlink target.", displayTarget);
      }
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

    const exactAllowlist = new Set(
      request.owningBinding.attachedCanonicalPaths.map((p) => normalizePathSlashes(p)),
    );
    if (!exactAllowlist.has(normalizePathSlashes(canonicalTarget))) {
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

  const platformRelative = cleaned.replace(/\\/g, path.sep);
  const candidatePath = isAbsolutePathCrossPlatform(cleaned)
    ? cleaned
    : path.resolve(canonicalRoot, platformRelative);

  const walked = safeWalkWithinCanonicalRoot(canonicalRoot, candidatePath);
  if (!walked.ok) {
    if (walked.code === "MISSING") {
      return fail(
        request.isRestoredMessage ? "STALE_LINK" : "MISSING_FILE",
        request.isRestoredMessage
          ? `Stale link: "${displayTarget}" no longer exists in "${workspaceDisplayName}".`
          : `File not found: "${displayTarget}" does not exist in "${workspaceDisplayName}".`,
        displayTarget,
      );
    }
    return fail(walked.code, walked.reason, displayTarget);
  }

  const relativePosix = path.relative(canonicalRoot, walked.canonicalPath).replace(/\\/g, "/");
  const isDirectory = walked.stat.isDirectory();
  const viewerKind = classifyViewer(walked.canonicalPath, isDirectory, request.preferSourceView);

  const descriptor: ResolvedPreviewDescriptor = {
    tabKey: buildPreviewTabKey(request.owningBinding, walked.canonicalPath, request.preferSourceView),
    viewerKind,
    canonicalPath: walked.canonicalPath,
    displayPath: relativePosix || workspaceDisplayName,
    breadcrumbs: buildProjectBreadcrumbs(workspaceDisplayName, relativePosix, isDirectory),
    parentBrowsingAllowed: true,
    anchor: request.anchor,
  };

  return { ok: true, descriptor };
}

function validatePreviewRelativePath(
  trimmed: string,
): { ok: true; cleanedTarget: string } | { ok: false; reason: string } {
  if (!trimmed) {
    return { ok: false, reason: "Preview path is empty." };
  }
  if (/[\x00-\x1f]/.test(trimmed)) {
    return { ok: false, reason: "Preview path contains control or NUL characters." };
  }
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
    return { ok: false, reason: "UNC, extended, and device paths are blocked." };
  }

  if (process.platform === "win32") {
    if (trimmed.startsWith("\\") || trimmed.includes(":")) {
      return {
        ok: false,
        reason: "Drive letters, drive-relative paths, and ADS syntax are blocked in preview URLs.",
      };
    }
    const segments = trimmed.split(/[\\/]+/).filter(Boolean);
    for (const seg of segments) {
      if (seg === "..") {
        return { ok: false, reason: "Parent traversal is blocked in preview URLs." };
      }
      const stripped = seg.replace(/[. ]+$/, "");
      const baseName = stripped.split(".")[0] ?? "";
      if (RESERVED_DOS_NAME_RE.test(baseName)) {
        return { ok: false, reason: `Reserved Windows device name "${seg}" is blocked.` };
      }
    }
    return { ok: true, cleanedTarget: trimmed.replace(/\\/g, path.sep) };
  }

  // On POSIX, colons and other legal filename characters are allowed inside workspace-relative
  // preview URLs (such as symlink targets into a `release:2026` subfolder), while parent traversal
  // segments ("..") and literal backslash separator coercion remain blocked.
  const segments = trimmed.split("/").filter(Boolean);
  for (const seg of segments) {
    if (seg === "..") {
      return { ok: false, reason: "Parent traversal is blocked in preview URLs." };
    }
  }
  return { ok: true, cleanedTarget: trimmed };
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
  const syntax = validatePreviewRelativePath(trimmed);
  if (!syntax.ok) {
    return { ok: false, statusCode: 403, reason: syntax.reason };
  }

  if (singleFileOnlyCanonicalPath) {
    const allowedName = path.basename(singleFileOnlyCanonicalPath);
    if (
      normalizeForComparison(trimmed, process.platform === "win32") !==
      normalizeForComparison(allowedName, process.platform === "win32")
    ) {
      return {
        ok: false,
        statusCode: 403,
        reason: "Standalone preview cannot access sibling files.",
      };
    }

    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(singleFileOnlyCanonicalPath);
    } catch {
      return { ok: false, statusCode: 404, reason: "Attached preview file missing." };
    }
    if (lstat.isSymbolicLink()) {
      try {
        const target = stripWin32ExtendedPrefix(fs.readlinkSync(singleFileOnlyCanonicalPath));
        if (target.startsWith("\\\\") || target.startsWith("//") || /[\x00-\x1f]/.test(target)) {
          return { ok: false, statusCode: 403, reason: "Unsafe standalone symlink target." };
        }
      } catch {
        return { ok: false, statusCode: 403, reason: "Standalone preview symlink unreadable." };
      }
    }

    const real = canonicalizeExistingPath(singleFileOnlyCanonicalPath);
    if (normalizePathSlashes(real) !== normalizePathSlashes(singleFileOnlyCanonicalPath)) {
      return { ok: false, statusCode: 403, reason: "Standalone preview realpath mismatch." };
    }
    return { ok: true, canonicalPath: real };
  }

  const candidate = path.resolve(canonicalScopeRoot, syntax.cleanedTarget);
  const walked = safeWalkWithinCanonicalRoot(canonicalScopeRoot, candidate);
  if (!walked.ok) {
    return {
      ok: false,
      statusCode: walked.code === "MISSING" ? 404 : 403,
      reason: walked.reason,
    };
  }
  return { ok: true, canonicalPath: walked.canonicalPath };
}

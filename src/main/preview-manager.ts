import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, protocol, session, WebContentsView, type BaseWindow, type Session } from "electron";
import type { PreviewBounds } from "../shared/contracts";
import { canonicalizeExistingPath, normalizeForComparison, resolvePreviewSubresource } from "./path-resolver";
import {
  mimeTypeForPath,
  PREVIEW_PROTOCOL_SCHEME,
  shouldAllowPreviewNetworkRequest,
  validateNavigationUrl,
} from "./preview-policy";

interface ScopeRegistration {
  token: string;
  canonicalRoot: string;
  singleFileOnlyCanonicalPath?: string;
}

interface ManagedIsolatedView {
  tabKey: string;
  kind: "html-preview" | "browser";
  workspaceToken?: string;
  allowExternalNetwork: boolean;
  view: WebContentsView;
  currentUrl: string;
  bounds: PreviewBounds;
}

export function registerPreviewProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true,
      },
    },
  ]);
}

export class IsolatedPreviewManager {
  private readonly hostWindow: BaseWindow;
  private readonly previewSession: Session;
  private readonly browserSession: Session;
  private readonly scopesByToken = new Map<string, ScopeRegistration>();
  private readonly tokenByScopeKey = new Map<string, string>();
  private readonly views = new Map<string, ManagedIsolatedView>();
  private readonly viewMetaByWebContentsId = new Map<number, ManagedIsolatedView>();
  private activeTabKey: string | null = null;
  private readonly onRequestNewBrowserTab: (url: string) => void;
  private readonly onBlockedNavigation: (tabKey: string, url: string, reason: string) => void;

  constructor(params: {
    hostWindow: BaseWindow;
    onRequestNewBrowserTab: (url: string) => void;
    onBlockedNavigation: (tabKey: string, url: string, reason: string) => void;
  }) {
    this.hostWindow = params.hostWindow;
    this.onRequestNewBrowserTab = params.onRequestNewBrowserTab;
    this.onBlockedNavigation = params.onBlockedNavigation;

    // Separate profiles stored outside project folders under Electron userData/browser-profiles
    const profileBase = path.join(app.getPath("userData"), "browser-profiles");
    fs.mkdirSync(profileBase, { recursive: true });

    // Non-persistent isolated partition for local HTML previews
    this.previewSession = session.fromPartition("omp-preview-isolated");
    // Dedicated persistent profile for visible browser tabs (never shares shell or personal browser profile)
    this.browserSession = session.fromPartition("persist:omp-browser-default");

    this.installPermissionDenial(this.previewSession);
    this.installPermissionDenial(this.browserSession);
    this.installProtocolHandler();
    this.installNetworkGuard(this.previewSession, "html-preview");
    this.installNetworkGuard(this.browserSession, "browser");
  }

  private installPermissionDenial(targetSession: Session): void {
    targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    targetSession.setPermissionCheckHandler(() => false);
    targetSession.setDevicePermissionHandler(() => false);
  }

  private installProtocolHandler(): void {
    this.previewSession.protocol.handle(PREVIEW_PROTOCOL_SCHEME, async (request) => {
      let parsed: URL;
      try {
        parsed = new URL(request.url);
      } catch {
        return new Response("Invalid preview URL", { status: 400 });
      }

      const token = parsed.hostname.toLowerCase();
      const scope = this.scopesByToken.get(token);
      if (!scope) {
        return new Response("Unknown preview workspace scope", { status: 403 });
      }

      const resolved = resolvePreviewSubresource(
        scope.canonicalRoot,
        parsed.pathname,
        scope.singleFileOnlyCanonicalPath,
      );
      if (!resolved.ok) {
        return new Response(resolved.reason, { status: resolved.statusCode });
      }

      try {
        const body = await fs.promises.readFile(resolved.canonicalPath);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": mimeTypeForPath(resolved.canonicalPath),
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
          },
        });
      } catch {
        return new Response("Failed to read preview resource", { status: 404 });
      }
    });
  }

  private installNetworkGuard(targetSession: Session, defaultKind: "html-preview" | "browser"): void {
    targetSession.webRequest.onBeforeRequest((details, callback) => {
      const managed =
        typeof details.webContentsId === "number"
          ? this.viewMetaByWebContentsId.get(details.webContentsId)
          : undefined;
      const decision = shouldAllowPreviewNetworkRequest({
        requestUrl: details.url,
        viewKind: managed?.kind ?? defaultKind,
        workspaceToken: managed?.workspaceToken,
        allowExternalNetwork: managed?.allowExternalNetwork ?? (defaultKind === "browser"),
      });
      if (!decision.allowed) {
        callback({ cancel: true });
        return;
      }
      callback({ cancel: false });
    });
  }

  registerWorkspaceScope(workspaceRoot: string): { token: string; canonicalRoot: string } {
    const canonicalRoot = canonicalizeExistingPath(workspaceRoot);
    const key = `workspace:${normalizeForComparison(canonicalRoot)}`;
    const existing = this.tokenByScopeKey.get(key);
    if (existing) {
      return { token: existing, canonicalRoot };
    }
    const token = `ws-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
    this.tokenByScopeKey.set(key, token);
    this.scopesByToken.set(token, { token, canonicalRoot });
    return { token, canonicalRoot };
  }

  registerStandaloneFileScope(canonicalFilePath: string): { token: string; previewUrl: string } {
    const canonical = canonicalizeExistingPath(canonicalFilePath);
    const key = `standalone:${normalizeForComparison(canonical)}`;
    let token = this.tokenByScopeKey.get(key);
    if (!token) {
      token = `sa-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
      this.tokenByScopeKey.set(key, token);
      this.scopesByToken.set(token, {
        token,
        canonicalRoot: path.dirname(canonical),
        singleFileOnlyCanonicalPath: canonical,
      });
    }
    const encodedName = encodeURIComponent(path.basename(canonical));
    return {
      token,
      previewUrl: `${PREVIEW_PROTOCOL_SCHEME}://${token}/${encodedName}`,
    };
  }

  buildWorkspacePreviewUrl(workspaceRoot: string, canonicalFilePath: string): { token: string; previewUrl: string } {
    const { token, canonicalRoot } = this.registerWorkspaceScope(workspaceRoot);
    const rel = path
      .relative(canonicalRoot, canonicalFilePath)
      .replace(/\\/g, "/")
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return {
      token,
      previewUrl: `${PREVIEW_PROTOCOL_SCHEME}://${token}/${rel}`,
    };
  }

  async openOrFocusView(params: {
    tabKey: string;
    kind: "html-preview" | "browser";
    url: string;
    workspaceToken?: string;
    allowExternalNetwork: boolean;
    bounds: PreviewBounds;
  }): Promise<{ ok: true; url: string; allowExternalNetwork: boolean } | { ok: false; error: string }> {
    const navCheck = validateNavigationUrl(params.url, params.kind, params.workspaceToken);
    if (!navCheck.allowed) {
      return { ok: false, error: navCheck.reason ?? "Blocked navigation URL." };
    }

    let managed = this.views.get(params.tabKey);
    if (!managed) {
      // Security invariant: ZERO preload, ZERO desktop IPC bridge, sandbox=true, contextIsolation=true, nodeIntegration=false
      const targetSession = params.kind === "html-preview" ? this.previewSession : this.browserSession;
      const view = new WebContentsView({
        webPreferences: {
          session: targetSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          spellcheck: false,
        },
      });

      managed = {
        tabKey: params.tabKey,
        kind: params.kind,
        workspaceToken: params.workspaceToken,
        allowExternalNetwork: params.kind === "browser" ? true : params.allowExternalNetwork,
        view,
        currentUrl: params.url,
        bounds: params.bounds,
      };
      this.views.set(params.tabKey, managed);
      this.viewMetaByWebContentsId.set(view.webContents.id, managed);

      const currentManaged = managed;
      view.webContents.on("will-navigate", (event, targetUrl) => {
        const check = validateNavigationUrl(targetUrl, currentManaged.kind, currentManaged.workspaceToken);
        if (!check.allowed) {
          event.preventDefault();
          this.onBlockedNavigation(currentManaged.tabKey, targetUrl, check.reason ?? "Blocked URI.");
        }
      });

      view.webContents.setWindowOpenHandler(({ url }) => {
        const browserCheck = validateNavigationUrl(url, "browser");
        if (browserCheck.allowed && currentManaged.kind === "browser") {
          this.onRequestNewBrowserTab(url);
        } else {
          this.onBlockedNavigation(
            currentManaged.tabKey,
            url,
            "Popup window blocked in isolated preview/browser view.",
          );
        }
        return { action: "deny" };
      });

      this.hostWindow.contentView.addChildView(view);
      await view.webContents.loadURL(params.url);
    }

    managed.bounds = params.bounds;
    this.showOnly(params.tabKey, params.bounds);
    return {
      ok: true,
      url: managed.currentUrl,
      allowExternalNetwork: managed.allowExternalNetwork,
    };
  }

  private showOnly(tabKey: string | null, bounds?: PreviewBounds): void {
    this.activeTabKey = tabKey;
    for (const [key, item] of this.views.entries()) {
      if (key === tabKey && bounds && bounds.width > 0 && bounds.height > 0) {
        item.bounds = bounds;
        item.view.setVisible(true);
        item.view.setBounds({
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        });
      } else {
        item.view.setVisible(false);
      }
    }
  }

  setBounds(tabKey: string, bounds: PreviewBounds): void {
    const managed = this.views.get(tabKey);
    if (!managed) return;
    managed.bounds = bounds;
    if (this.activeTabKey === tabKey) {
      if (bounds.width <= 0 || bounds.height <= 0) {
        managed.view.setVisible(false);
      } else {
        managed.view.setVisible(true);
        managed.view.setBounds({
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        });
      }
    }
  }

  hideAll(): void {
    this.showOnly(null);
  }

  async setExternalNetworkPolicy(
    tabKey: string,
    allowExternalNetwork: boolean,
  ): Promise<{ ok: boolean; allowExternalNetwork: boolean }> {
    const managed = this.views.get(tabKey);
    if (!managed || managed.kind !== "html-preview") {
      return { ok: false, allowExternalNetwork: false };
    }
    managed.allowExternalNetwork = allowExternalNetwork;
    await managed.view.webContents.reload();
    return { ok: true, allowExternalNetwork: managed.allowExternalNetwork };
  }

  async navigateBrowser(
    tabKey: string,
    url: string,
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const managed = this.views.get(tabKey);
    if (!managed || managed.kind !== "browser") {
      return { ok: false, error: "Browser tab not found." };
    }
    const check = validateNavigationUrl(url, "browser");
    if (!check.allowed) {
      return { ok: false, error: check.reason ?? "Blocked URL." };
    }
    managed.currentUrl = url;
    await managed.view.webContents.loadURL(url);
    return { ok: true, url };
  }

  closeView(tabKey: string): void {
    const managed = this.views.get(tabKey);
    if (!managed) return;
    if (this.activeTabKey === tabKey) {
      this.activeTabKey = null;
    }
    this.views.delete(tabKey);
    this.viewMetaByWebContentsId.delete(managed.view.webContents.id);
    try {
      this.hostWindow.contentView.removeChildView(managed.view);
    } catch {
      // ignore if window already closing
    }
    if (!managed.view.webContents.isDestroyed()) {
      managed.view.webContents.close();
    }
  }

  disposeAll(): void {
    for (const key of Array.from(this.views.keys())) {
      this.closeView(key);
    }
  }
}

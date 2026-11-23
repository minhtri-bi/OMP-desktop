import { describe, expect, it } from "vitest";
import {
  PREVIEW_PROTOCOL_SCHEME,
  shouldAllowPreviewNetworkRequest,
  validateNavigationUrl,
} from "../../src/main/preview-policy";

describe("preview-policy (origin isolation, URI blocking, default-blocked network)", () => {
  it("allows same-workspace omp-preview navigation and blocks cross-workspace navigation", () => {
    expect(
      validateNavigationUrl(`${PREVIEW_PROTOCOL_SCHEME}://ws-aaa/web/preview.html`, "html-preview", "ws-aaa")
        .allowed,
    ).toBe(true);

    expect(
      validateNavigationUrl(`${PREVIEW_PROTOCOL_SCHEME}://ws-bbb/web/preview.html`, "html-preview", "ws-aaa")
        .allowed,
    ).toBe(false);
  });

  it("blocks dangerous URI schemes across both html-preview and browser views", () => {
    const blocked = [
      "file:///C:/Windows/win.ini",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ms-msdt:/id%20PCWDiagnostic",
      "cmd:/c%20calc",
      "shell:AppsFolder",
      "powershell:Get-Process",
      "smb://127.0.0.1/c$",
      "ftp://example.com/file",
    ];

    for (const url of blocked) {
      expect(validateNavigationUrl(url, "html-preview", "ws-aaa").allowed, url).toBe(false);
      expect(validateNavigationUrl(url, "browser").allowed, url).toBe(false);
    }
  });

  it("blocks external HTTP/HTTPS requests on local HTML previews by default and permits per-tab opt-in", () => {
    const defaultBlocked = shouldAllowPreviewNetworkRequest({
      requestUrl: "https://exfil.example.com/steal",
      viewKind: "html-preview",
      workspaceToken: "ws-aaa",
      allowExternalNetwork: false,
    });
    expect(defaultBlocked.allowed).toBe(false);

    const optInAllowed = shouldAllowPreviewNetworkRequest({
      requestUrl: "https://cdn.example.com/lib.js",
      viewKind: "html-preview",
      workspaceToken: "ws-aaa",
      allowExternalNetwork: true,
    });
    expect(optInAllowed.allowed).toBe(true);

    // Same-workspace subresources always allowed even when external network is blocked
    const localAsset = shouldAllowPreviewNetworkRequest({
      requestUrl: `${PREVIEW_PROTOCOL_SCHEME}://ws-aaa/web/preview.js`,
      viewKind: "html-preview",
      workspaceToken: "ws-aaa",
      allowExternalNetwork: false,
    });
    expect(localAsset.allowed).toBe(true);

    // Cross-workspace subresources remain blocked even when external network opt-in is enabled
    const crossWorkspace = shouldAllowPreviewNetworkRequest({
      requestUrl: `${PREVIEW_PROTOCOL_SCHEME}://ws-bbb/secret.js`,
      viewKind: "html-preview",
      workspaceToken: "ws-aaa",
      allowExternalNetwork: true,
    });
    expect(crossWorkspace.allowed).toBe(false);
  });
});

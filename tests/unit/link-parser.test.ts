import { describe, expect, it } from "vitest";
import { parseReplyLinks } from "../../src/shared/link-parser";

describe("link-parser (live OMP reply file/URL link extraction)", () => {
  it("extracts Markdown file links with #L and :line anchors and strips optional titles", () => {
    const text =
      'See [implementation](src/hello.ts#L5-L10 "Hello fn"), [`README.md`](README.md:2-4), and [spec](<docs/my spec.pdf>).';
    const links = parseReplyLinks(text, "msg-1");
    expect(links).toHaveLength(3);
    expect(links[0]).toMatchObject({
      label: "implementation",
      rawTarget: "src/hello.ts",
      anchor: { startLine: 5, endLine: 10 },
      kind: "file",
    });
    expect(links[1]).toMatchObject({
      label: "README.md",
      rawTarget: "README.md",
      anchor: { startLine: 2, endLine: 4 },
      kind: "file",
    });
    expect(links[2]).toMatchObject({
      label: "spec",
      rawTarget: "docs/my spec.pdf",
      anchor: undefined,
      kind: "file",
    });
  });

  it("extracts file:// URIs, external https links, and ignores dangerous schemes and fenced code", () => {
    const text = [
      "Open [local](file:///C:/Work/app/src/index.ts#L12) or [docs](https://example.com/guide#top).",
      "Ignore [bad](javascript:alert(1)), [enc-bad](javascript%3Aalert(1)), [data](data:text/html,hi), and ![img](logo.png).",
      "```ts",
      "const ignored = '[fake](src/ignored.ts#L1)';",
      "```",
      "Also inspect `src/utils.ts#L3-L7`.",
    ].join("\n");

    const links = parseReplyLinks(text, "msg-2");
    expect(links.map((l) => ({ label: l.label, rawTarget: l.rawTarget, kind: l.kind, anchor: l.anchor }))).toEqual([
      {
        label: "local",
        rawTarget: "file:///C:/Work/app/src/index.ts",
        kind: "file",
        anchor: { startLine: 12 },
      },
      {
        label: "docs",
        rawTarget: "https://example.com/guide#top",
        kind: "external-url",
        anchor: undefined,
      },
      {
        label: "src/utils.ts#L3-L7",
        rawTarget: "src/utils.ts",
        kind: "file",
        anchor: { startLine: 3, endLine: 7 },
      },
    ]);
  });

  it("handles parenthesized filenames including Windows separators, escaped parens, leading and nested pairs", () => {
    const text = [
      "Check [v2](docs/spec(v2).pdf) and again [same](docs/spec(v2).pdf) plus `docs/spec(v2).pdf`.",
      "Also check [draft]((draft).md), [nested](docs/Spec(v1(a)).md#L2-L4), [win](docs\\(draft).md#L3), and [esc](docs/spec\\(v2\\).md).",
    ].join("\n");
    const links = parseReplyLinks(text, "msg-3");
    expect(links.map((l) => ({ label: l.label, rawTarget: l.rawTarget, anchor: l.anchor }))).toEqual([
      { label: "v2", rawTarget: "docs/spec(v2).pdf", anchor: undefined },
      { label: "draft", rawTarget: "(draft).md", anchor: undefined },
      { label: "nested", rawTarget: "docs/Spec(v1(a)).md", anchor: { startLine: 2, endLine: 4 } },
      { label: "win", rawTarget: "docs\\(draft).md", anchor: { startLine: 3 } },
      { label: "esc", rawTarget: "docs/spec(v2).md", anchor: undefined },
    ]);
  });

  it("decodes percent-encoded Markdown links, accepts unquoted spaced Markdown file links, and preserves file:// and backticks", () => {
    const text = [
      "Read [guide](docs/User%20Guide.md#L3), [bare-space](docs/User Guide.md#L2), [pct](docs/100%25.md).",
      'Also [bare-titled](docs/Team Guide.md#L4 "Team Guide") and ignore prose [note](see above for details).',
      "Keep URI untouched: [uri](file:///C:/Work/User%20Guide.md#L2).",
      "Spaced backticks: `docs/Release Notes.md` and `docs/Install Guide.md#L4-L6` and literal `docs/100%25.md`.",
    ].join("\n");

    const links = parseReplyLinks(text, "msg-4");
    expect(links.map((l) => ({ label: l.label, rawTarget: l.rawTarget, anchor: l.anchor }))).toEqual([
      { label: "guide", rawTarget: "docs/User Guide.md", anchor: { startLine: 3 } },
      { label: "bare-space", rawTarget: "docs/User Guide.md", anchor: { startLine: 2 } },
      { label: "pct", rawTarget: "docs/100%.md", anchor: undefined },
      { label: "bare-titled", rawTarget: "docs/Team Guide.md", anchor: { startLine: 4 } },
      { label: "uri", rawTarget: "file:///C:/Work/User%20Guide.md", anchor: { startLine: 2 } },
      { label: "docs/Release Notes.md", rawTarget: "docs/Release Notes.md", anchor: undefined },
      {
        label: "docs/Install Guide.md#L4-L6",
        rawTarget: "docs/Install Guide.md",
        anchor: { startLine: 4, endLine: 6 },
      },
      { label: "docs/100%25.md", rawTarget: "docs/100%25.md", anchor: undefined },
    ]);
  });

  it("filters out shell commands in backticks while preserving valid filenames with ampersands and leading hyphens", () => {
    const text = [
      "Run `cat README.md`, `git diff src/app.ts`, `node scripts/build.mjs`, or `./run.sh README.md`.",
      "Do keep single-token files `docs/R&D.md`, `-notes.md`, and spaced `docs/R&D Notes.md#L2`.",
    ].join("\n");

    const links = parseReplyLinks(text, "msg-5");
    expect(links.map((l) => ({ label: l.label, rawTarget: l.rawTarget, anchor: l.anchor }))).toEqual([
      { label: "docs/R&D.md", rawTarget: "docs/R&D.md", anchor: undefined },
      { label: "-notes.md", rawTarget: "-notes.md", anchor: undefined },
      { label: "docs/R&D Notes.md#L2", rawTarget: "docs/R&D Notes.md", anchor: { startLine: 2 } },
    ]);
  });
});

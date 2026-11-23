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
      "Ignore [bad](javascript:alert(1)), [data](data:text/html,hi), and ![img](logo.png).",
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

  it("deduplicates repeated targets and preserves parenthesized filenames", () => {
    const text =
      "Check [v2](docs/spec(v2).pdf) and again [same](docs/spec(v2).pdf) plus `docs/spec(v2).pdf`.";
    const links = parseReplyLinks(text, "msg-3");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      label: "v2",
      rawTarget: "docs/spec(v2).pdf",
      kind: "file",
    });
  });
});

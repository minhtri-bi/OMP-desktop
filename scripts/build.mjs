import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const distDir = path.join(root, "dist");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(path.join(distDir, "main"), { recursive: true });
fs.mkdirSync(path.join(distDir, "preload"), { recursive: true });
fs.mkdirSync(path.join(distDir, "renderer"), { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(root, "src/main/main.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "koffi"],
    outfile: path.join(distDir, "main/main.cjs"),
    sourcemap: true,
  }),
  build({
    entryPoints: [path.join(root, "src/preload/preload.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    outfile: path.join(distDir, "preload/preload.cjs"),
    sourcemap: true,
  }),
  build({
    entryPoints: [path.join(root, "src/renderer/app.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outfile: path.join(distDir, "renderer/app.js"),
    sourcemap: true,
  }),
]);

fs.copyFileSync(
  path.join(root, "src/renderer/index.html"),
  path.join(distDir, "renderer/index.html"),
);
fs.copyFileSync(
  path.join(root, "src/renderer/styles.css"),
  path.join(distDir, "renderer/styles.css"),
);
fs.copyFileSync(
  path.join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
  path.join(distDir, "renderer/pdf.worker.min.mjs"),
);

console.log("Built OMP Desktop into dist/");

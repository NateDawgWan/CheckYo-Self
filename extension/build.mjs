// Builds the extension into extension/dist/ — that's the folder you load in Chrome.
//   node build.mjs           one build
//   node build.mjs --watch   rebuild on every save (then click "reload" on chrome://extensions)
import * as esbuild from "esbuild";
import { cpSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");

rmSync("dist", { recursive: true, force: true });
cpSync("public", "dist", { recursive: true }); // manifest.json, popup.html, popup.css

const common = {
  bundle: true,          // pulls in ../shared/contract.ts too
  outdir: "dist",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
  loader: { ".css": "text" }, // `import css from "x.css"` gives the file as a string
};

const builds = [
  // The popup and the service worker are ES modules.
  { ...common, entryPoints: { popup: "src/popup.ts", background: "src/background.ts" }, format: "esm" },
  // Content scripts can't be ES modules, so the Instagram script is one plain file.
  { ...common, entryPoints: { instagram: "src/content/main.ts" }, format: "iife" },
];

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
  console.log("Watching src/ ... (edits to public/ need a restart)");
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}

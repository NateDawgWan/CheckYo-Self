// Builds the extension into extension/dist/ — that's the folder you load in Chrome.
//   node build.mjs           one build
//   node build.mjs --watch   rebuild on every save (then click "reload" on chrome://extensions)
import * as esbuild from "esbuild";
import { cpSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");

rmSync("dist", { recursive: true, force: true });
cpSync("public", "dist", { recursive: true }); // manifest.json, popup.html, popup.css

const options = {
  entryPoints: ["src/popup.ts"],
  bundle: true,          // pulls in ../shared/contract.ts too
  outdir: "dist",
  format: "esm",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching src/ ... (edits to public/ need a restart)");
} else {
  await esbuild.build(options);
}

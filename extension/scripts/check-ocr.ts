// Runs the REAL OCR engine (Tesseract.js, in Node) on the fictional demo
// images and checks what comes out, using the same conversion code the
// extension uses (src/ocr/convert.ts). Slower than `npm test` (a few seconds),
// so it's a separate command:
//   npm run check:ocr
//
// Node, not Chrome: this checks the engine version, the bundled language file
// and our conversion. It does NOT check that the extension can load the worker
// and WASM; for that, open ocr-demo.html in the loaded extension (see
// src/ocr/README.md). Uses only local files; nothing is downloaded.
import { readFileSync } from "node:fs";
import { createWorker } from "tesseract.js";
import { pageToOcrResult, type RawPage } from "../src/ocr/convert";
import { locateQuote } from "../src/ocr/review";
import type { OcrResult } from "../src/ocr/types";

const IMAGES = "src/ocr/demo/images";
const LANG_DIR = "node_modules/@tesseract.js-data/eng/4.0.0_best_int"; // same file build.mjs bundles

/** Reads width and height from a PNG file header (bytes 16-23). */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
  if (!ok) failures++;
}

const worker = await createWorker("eng", 1, { langPath: LANG_DIR, cacheMethod: "none", gzip: true });

async function scan(name: string): Promise<OcrResult> {
  const bytes = readFileSync(`${IMAGES}/${name}`);
  const { width, height } = pngSize(bytes);
  const { data } = await worker.recognize(bytes, {}, { text: true, blocks: true });
  const result = pageToOcrResult(data as RawPage, 1, width, height, "check-ocr");
  console.log(`\n${name}: status=${result.status}, ${result.words.length} words, confidence=${result.confidence}`);
  console.log(`  text: ${JSON.stringify(result.text)}`);
  return result;
}

try {
  // 1. Clear printed text: the important words must be read and locatable.
  const banner = await scan("team-banner.png");
  check(banner.status === "text_found", "banner: text found");
  for (const quote of ["Riverside Youth Soccer", "Coach Dana", "608-555-0142"]) {
    const where = locateQuote(banner, quote);
    check(where.found, `banner: "${quote}" read and located (${where.wordIds.join(", ")})`);
  }
  const phone = locateQuote(banner, "608-555-0142");
  // The phone number is drawn at about x=330..590, y=250..290 in a 900x420 image.
  const box = phone.boxes[0];
  check(!!box && box.x0 > 250 && box.x1 < 650 && box.y0 > 230 && box.y1 < 310, "banner: phone box is where it was drawn");
  check(banner.imageWidth === 900 && banner.imageHeight === 420, "banner: original size kept");

  // 2. No text: must be a SUCCESSFUL scan, and must not invent real words.
  const blank = await scan("no-text.png");
  check(blank.status === "no_text" || blank.words.every((w) => w.confidence < 70),
    "no-text: empty, or only low-confidence noise for the user to delete");

  // 3./4. Limitations: printed for information, not checked.
  await scan("rotated-sign.png");
  await scan("script-card.png");
} finally {
  await worker.terminate();
}

console.log(failures === 0 ? "\nOCR check passed." : `\nOCR check FAILED (${failures}).`);
process.exit(failures === 0 ? 0 : 1);

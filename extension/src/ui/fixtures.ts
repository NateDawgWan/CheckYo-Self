// DEVELOPMENT FIXTURES — made-up data for building and testing the warning
// interface before OCR (milestone 2) and history storage (milestone 3) exist.
// Everything here is labeled as a fixture wherever it is shown. Delete the
// fixture buttons in popup.html once the real integrations land.
import type { HistoryPost, OcrResult, OcrWord } from "../../../shared/contract";
import type { OcrInput } from "./ocr";

const FIXTURE_LINES = ["Riverside Youth Soccer,", "U10 Tigers.", "Coach Dana 608-555-0142"];

/**
 * A fake "photo" drawn on a canvas right here in the popup (nothing is
 * downloaded), with word boxes measured from the drawing, shaped like
 * Tesseract.js output. NOT real OCR.
 */
export function makeFixtureOcr(): OcrInput {
  const width = 480;
  const height = 270;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // A simple "banner on a fence" scene.
  ctx.fillStyle = "#6c9a5b";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#f5f1e6";
  ctx.fillRect(40, 40, width - 80, height - 80);
  ctx.strokeStyle = "#1f3b70";
  ctx.lineWidth = 6;
  ctx.strokeRect(40, 40, width - 80, height - 80);

  const words: OcrWord[] = [];
  ctx.fillStyle = "#1f3b70";
  ctx.textBaseline = "alphabetic";
  const fontSize = 28;
  ctx.font = `bold ${fontSize}px sans-serif`;
  FIXTURE_LINES.forEach((line, row) => {
    const baseline = 100 + row * 50;
    let x = 64;
    for (const word of line.split(" ")) {
      const w = ctx.measureText(word).width;
      ctx.fillText(word, x, baseline);
      words.push({
        text: word,
        bbox: {
          x0: Math.floor(x) - 2,
          y0: baseline - fontSize,
          x1: Math.ceil(x + w) + 2,
          y1: baseline + 6,
        },
      });
      x += w + ctx.measureText(" ").width;
    }
  });

  const result: OcrResult = {
    sourceId: "image_text:1",
    text: FIXTURE_LINES.join(" "),
    confidence: 64, // below the "check carefully" threshold, to show that hint
    words,
  };
  return { result, imageUrl: canvas.toDataURL("image/png"), isFixture: true };
}

/** Made-up earlier posts for the history panel's fixture mode. */
export const FIXTURE_HISTORY_CANDIDATES: HistoryPost[] = [
  {
    postId: "fixture-1",
    postedAt: "2026-09-12T18:20:00Z",
    caption: "New front door on Maple St finally painted! 🎨",
  },
  {
    postId: "fixture-2",
    postedAt: "2026-10-03T16:05:00Z",
    caption: "Sam's first game with the Tigers ⚽",
    imageText: "Riverside Youth Soccer",
  },
  {
    postId: "fixture-3",
    postedAt: "2026-10-29T09:40:00Z",
    caption: "Coffee before work, same as every Monday",
  },
];

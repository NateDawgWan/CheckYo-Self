// The states the warning interface can be in, and the words we show for each.
// Pure functions (no DOM) so they can be tested in Node.
//
// The most important rule here: a VALID EMPTY result ("nothing stood out") must
// never be confused with a check that failed, was cut short, or never ran.
import type { AnalyzeResponse, ErrorCode } from "../../../shared/contract";

/** Everything the results area can show. Exactly one at a time. */
export type AnalysisView =
  | { kind: "idle" }                                   // nothing checked yet
  | { kind: "loading"; sourceCount: number }           // request in flight
  | { kind: "completed"; result: AnalyzeResponse }     // got a valid AnalyzeResponse
  | { kind: "skipped" }                                // user chose "continue without analysis"
  | { kind: "unavailable"; reason: string }            // backend unreachable / wrong version
  | { kind: "error"; message: string; code?: ErrorCode; requestId?: string }; // request failed

/**
 * What a completed result means:
 *  - "clean":      no findings AND nothing dropped (the only case that may say "nothing stood out")
 *  - "findings":   at least one finding, nothing dropped
 *  - "incomplete": the backend dropped findings, so the check is NOT complete
 */
export type ResultOutcome = "clean" | "findings" | "incomplete";

export function resultOutcome(result: AnalyzeResponse): ResultOutcome {
  if (result.droppedFindings > 0) return "incomplete";
  return result.findings.length === 0 ? "clean" : "findings";
}

/** Friendly explanation for each error code from the backend. */
export function describeError(code: ErrorCode | undefined, message: string): { title: string; detail: string } {
  const notClean = "No results are shown. This is NOT a clean result: the post was not checked.";
  switch (code) {
    case "UPSTREAM_TIMEOUT":
      return { title: "The analysis took too long", detail: `${notClean} Try again in a moment.` };
    case "UPSTREAM_ERROR":
      return { title: "The analysis service returned an error", detail: `${notClean} ${message}` };
    case "BAD_MODEL_OUTPUT":
      return { title: "The AI's answer couldn't be read", detail: `${notClean} Try checking again.` };
    case "BAD_REQUEST":
      return { title: "The draft couldn't be sent", detail: `${notClean} ${message}` };
    case "FORBIDDEN":
      return { title: "The backend refused the request", detail: `${notClean} ${message}` };
    default:
      return { title: "The check failed", detail: `${notClean} ${message}`.trim() };
  }
}

/** One short line for the status message under the draft. */
export function statusLine(view: AnalysisView): { text: string; kind: "info" | "error" } {
  switch (view.kind) {
    case "idle":
      return { text: "", kind: "info" };
    case "loading":
      return { text: `Checking ${view.sourceCount} piece${view.sourceCount === 1 ? "" : "s"} of text…`, kind: "info" };
    case "skipped":
      return { text: "Not checked. You chose to continue without analysis.", kind: "info" };
    case "unavailable":
      return { text: "Analysis is unavailable right now.", kind: "error" };
    case "error":
      return { text: "The check failed. Nothing was analyzed.", kind: "error" };
    case "completed": {
      const n = view.result.findings.length;
      switch (resultOutcome(view.result)) {
        case "clean":
          return { text: "Check complete. Nothing stood out.", kind: "info" };
        case "findings":
          return { text: `Check complete: ${n} thing${n === 1 ? "" : "s"} to review.`, kind: "info" };
        case "incomplete":
          return {
            text: `Check incomplete: ${n} thing${n === 1 ? "" : "s"} shown, ${view.result.droppedFindings} not shown.`,
            kind: "error",
          };
      }
    }
  }
}

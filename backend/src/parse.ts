// Turns the LLM's raw text into safe, well-shaped Finding objects.
// Never trust the model's output shape: fix what we can, drop what we can't.
import {
  CATEGORIES,
  EDIT_ACTIONS,
  LEVELS,
  type Category,
  type EditAction,
  type Evidence,
  type Finding,
  type Level,
  type SuggestedEdit,
  type TextSource,
} from "../../shared/contract";
import { AppError } from "./errors";

const MAX_FINDINGS = 8;

export function parseModelOutput(raw: string, sources: TextSource[]): { summary: string; findings: Finding[] } {
  const json = extractJsonObject(raw);
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  const summary = typeof json.summary === "string" ? json.summary.trim().slice(0, 500) : "";
  const rawFindings: unknown[] = Array.isArray(json.findings) ? json.findings : [];

  const findings = rawFindings
    .map((f) => normalizeFinding(f, sourceById))
    .filter((f): f is Omit<Finding, "id"> => f !== null)
    .slice(0, MAX_FINDINGS)
    .map((f, i) => ({ id: `f${i + 1}`, ...f }));

  return { summary, findings };
}

/** Models sometimes wrap JSON in ```json fences or add a sentence. Find the object. */
function extractJsonObject(raw: string): Record<string, any> {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new AppError("BAD_MODEL_OUTPUT", 502, "The model did not return JSON. Try again.");
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new AppError("BAD_MODEL_OUTPUT", 502, "The model returned malformed JSON. Try again.");
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Case- and whitespace-insensitive "does the source really contain this quote?" */
export function quoteAppearsIn(sourceText: string, quote: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const q = norm(quote);
  return q.length > 0 && norm(sourceText).includes(q);
}

function normalizeFinding(raw: unknown, sourceById: Map<string, TextSource>): Omit<Finding, "id"> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const f = raw as Record<string, unknown>;

  const exposure = str(f.exposure, 400);
  if (!exposure) return null;

  // Evidence = OBSERVED text. We check every quote against the real source text.
  const evidence: Evidence[] = (Array.isArray(f.evidence) ? f.evidence : [])
    .map((e: any): Evidence | null => {
      const source = sourceById.get(e?.sourceId);
      const quote = str(e?.quote, 200);
      if (!source || !quote) return null;
      return { sourceId: source.id, quote, verified: quoteAppearsIn(source.text, quote) };
    })
    .filter((e): e is Evidence => e !== null)
    .slice(0, 6);

  // A warning we can't connect to any text isn't useful — drop it.
  if (evidence.length === 0) return null;

  const suggestedEdits: SuggestedEdit[] = (Array.isArray(f.suggestedEdits) ? f.suggestedEdits : [])
    .map((s: any): SuggestedEdit | null => {
      if (!sourceById.has(s?.sourceId)) return null;
      const explanation = str(s?.explanation, 300);
      if (!explanation) return null;
      const edit: SuggestedEdit = {
        sourceId: s.sourceId,
        action: pick<EditAction>(s?.action, EDIT_ACTIONS, "other"),
        explanation,
      };
      const original = str(s?.original, 200);
      const replacement = typeof s?.replacement === "string" ? s.replacement.slice(0, 200) : "";
      if (original) edit.original = original;
      if (replacement) edit.replacement = replacement;
      return edit;
    })
    .filter((s): s is SuggestedEdit => s !== null)
    .slice(0, 4);

  return {
    category: pick<Category>(f.category, CATEGORIES, "other"),
    severity: pick<Level>(f.severity, LEVELS, "medium"),
    exposure,
    evidence,
    // Computed by us, not the model: does the evidence span more than one source?
    crossSource: new Set(evidence.map((e) => e.sourceId)).size > 1,
    confidence: pick<Level>(f.confidence, LEVELS, "low"),
    uncertainty: str(f.uncertainty, 400),
    suggestedEdits,
  };
}

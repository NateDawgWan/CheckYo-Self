// Tiny DOM helpers shared by the warning-interface modules.
// SAFETY: every piece of text goes through textContent, never innerHTML, so
// captions, OCR text and model output can't inject HTML into the popup.

/** Create an element with an optional class and optional text. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Create a <button type="button"> (never a form submit button). */
export function button(label: string, className: string, onClick: () => void) {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

/** Scroll an element into view and briefly outline it. */
export function flash(node: Element | null) {
  if (!node) return;
  node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  node.classList.remove("flash");
  void (node as HTMLElement).offsetWidth; // restart the animation
  node.classList.add("flash");
}

/** Short, locale-independent date for history posts: "2026-03-02". */
export function shortDate(iso: string | undefined): string {
  if (!iso) return "date unknown";
  const day = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "date unknown";
}

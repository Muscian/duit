import type { Observation } from "./types.js";

/** Bounded evidence for an authoring LLM; full observations remain on disk. */
export function summarizeObservation(o: Observation) {
  const controls = o.elements.filter(
    (e) => e.visible && !e.blockedByModal && e.role,
  );
  const counts = new Map<string, number>();
  for (const e of controls) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const compactContext = (context: string) =>
    context.length > 200
      ? `${context.slice(0, 100)} … ${context.slice(-100)}`
      : context;
  return {
    url: o.url.replace(/[?#].*$/, ""),
    title: o.title,
    dialogs: o.dialogs,
    text: o.text?.slice(0, 6000),
    controls: controls.slice(0, 100).map((e) => ({
      role: e.role,
      name: e.name,
      context:
        !e.name || (counts.get(e.name) ?? 0) > 1
          ? compactContext(e.context)
          : "",
      occluded: e.occluded || undefined,
      disabled: e.disabled,
      checked: e.checked,
      placeholder: e.placeholder,
      options: e.options?.slice(0, 30),
      omittedOptions:
        e.options && e.options.length > 30 ? e.options.length - 30 : undefined,
    })),
    omittedControls: Math.max(0, controls.length - 100),
  };
}

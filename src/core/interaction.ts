import type {
  InteractionOptions,
  Observation,
  ElementCandidate,
} from "./types.js";

/** Only observed controls in recognized incidental notices are eligible. */
export function incidentalControl(
  observation: Observation,
  policy?: InteractionOptions,
): { category: string; control: ElementCandidate } | undefined {
  if (!policy) return;
  policy = {
    ...(policy.profile === "test"
      ? {
          cookies: "accept" as const,
          onboarding: "dismiss" as const,
          reminders: "later" as const,
          unsavedChanges: "discard" as const,
        }
      : {}),
    ...policy,
  };
  const controls = observation.elements.filter(
    (e) =>
      e.visible &&
      !e.occluded &&
      !e.blockedByModal &&
      !e.disabled &&
      /^(button|link)$/.test(e.role),
  );
  for (const e of controls) {
    const name = e.name.trim();
    const nearby = `${e.overlay ?? ""} ${e.context}`;
    if (/\bcookies?\b|\bconsent\b/i.test(nearby)) {
      if (
        policy.cookies === "accept" &&
        /^(accept all(?: cookies)?|allow all(?: cookies)?|accept cookies|aceptar (?:todas las )?cookies)$/i.test(
          name,
        )
      )
        return { category: "cookies", control: e };
      if (
        policy.cookies === "reject" &&
        /^(reject all(?: cookies)?|decline all|only necessary|necessary only|rechazar (?:todas las )?cookies)$/i.test(
          name,
        )
      )
        return { category: "cookies", control: e };
    }
    if (
      policy.onboarding === "dismiss" &&
      /welcome|tour|onboarding|bienvenid/i.test(nearby) &&
      /^(skip(?: tour)?(?: and close dialog)?|start exploring|got it|no thanks|omitir)$/i.test(
        name,
      )
    )
      return { category: "onboarding", control: e };
    if (
      policy.unsavedChanges === "discard" &&
      /unsaved changes|cambios sin guardar/i.test(nearby) &&
      /^(discard changes|discard|descartar cambios)$/i.test(name)
    )
      return { category: "unsaved changes", control: e };
    if (
      policy.reminders === "later" &&
      /confirm.*email|verify email|reminder|recordatorio/i.test(nearby) &&
      /^(not now|remind me later|maybe later|ahora no)$/i.test(name)
    )
      return { category: "reminders", control: e };
  }
}

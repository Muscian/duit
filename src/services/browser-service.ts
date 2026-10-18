import { lazyWriter } from "../providers/openai-content.js";
import { BrowserAdapter } from "../platforms/browser.js";
import { JevProvider } from "../providers/jev.js";
import { resolveVariables } from "../core/input.js";
import { DuitService, PlatformRegistry } from "./service.js";
import type { DecisionProvider } from "../core/types.js";

/** Construct the model only if a decision is needed: fully explicit cases need no key. */
export function lazyJev(): DecisionProvider {
  let provider: JevProvider | undefined;
  const get = () => (provider ??= new JevProvider());
  return {
    decide: (...args) => get().decide(...args),
    locate: (...args) => get().locate(...args),
    close: async () => {
      await provider?.close();
    },
  };
}
export function browserService(artifactsRoot?: string) {
  const platforms = new PlatformRegistry().register(
    "browser",
    (spec) =>
      new BrowserAdapter({
        ...spec.browser,
        maskValues: [
          ...(spec.privacy?.redact ?? []),
          ...Object.entries(resolveVariables(spec.variables))
            .filter(([name]) => !spec.publicVariables?.includes(name))
            .map(([, v]) => v),
        ],
      }),
  );
  return new DuitService({
    platforms,
    provider: lazyJev,
    contentProvider: lazyWriter,
    artifactsRoot,
  });
}

import type { BrowserContext, Page, Request } from "@playwright/test";
import { HarnessError, type PlatformDiagnostics } from "../core/types.js";
import { diagnosticUrl } from "./browser-network.js";

type NetworkEvent = PlatformDiagnostics["events"][number];

/** Bounded, URL-scrubbed evidence. Never records bodies, headers or console text. */
export class BrowserNetworkDiagnostics {
  private failures = new Map<string, NetworkEvent>();
  private page?: Page;

  constructor(private record: (event: NetworkEvent) => void) {}

  private critical(request: Request): boolean {
    return (
      ["script", "stylesheet"].includes(request.resourceType()) &&
      request.frame() === this.page?.mainFrame()
    );
  }

  private fail(request: Request, event: NetworkEvent) {
    this.record(event);
    if (this.critical(request) && event.message !== "net::ERR_ABORTED") {
      this.failures.set(request.url(), event);
      if (this.failures.size > 100)
        this.failures.delete(this.failures.keys().next().value!);
    }
  }

  attach(context: BrowserContext) {
    context.on("request", (request) => {
      if (
        request.isNavigationRequest() &&
        request.frame() === this.page?.mainFrame()
      )
        this.failures.clear();
    });
    context.on("requestfailed", (request) =>
      this.fail(request, {
        kind: "request_failed",
        url: diagnosticUrl(request.url()),
        resourceType: request.resourceType(),
        // Browser error codes only; a transport implementation may include URLs.
        message:
          request.failure()?.errorText.match(/net::[A-Z0-9_]+/)?.[0] ??
          "request failed",
      }),
    );
    context.on("response", (response) => {
      if (response.status() >= 400)
        this.fail(response.request(), {
          kind: "http_error",
          url: diagnosticUrl(response.url()),
          resourceType: response.request().resourceType(),
          status: response.status(),
        });
    });
    context.on("requestfinished", (request) => {
      // requestfinished includes HTTP errors; only successful retries recover a failure.
      void request
        .response()
        .then((response) => {
          if (response && response.status() < 400)
            this.failures.delete(request.url());
        })
        .catch(() => {});
    });
  }

  async attachPage(page: Page, chromium: boolean) {
    this.page = page;
    if (!chromium) return;
    const session = await page.context().newCDPSession(page);
    const requests = new Map<string, { url: string; resourceType: string }>();
    session.on("Network.requestWillBeSent", (event) => {
      requests.set(event.requestId, {
        url: diagnosticUrl(event.request.url),
        resourceType: event.type?.toLowerCase() ?? "other",
      });
      if (requests.size > 500) requests.delete(requests.keys().next().value!);
    });
    session.on("Network.loadingFinished", (event) =>
      requests.delete(event.requestId),
    );
    session.on("Network.loadingFailed", (event) => {
      const request = requests.get(event.requestId);
      requests.delete(event.requestId);
      if (!request) return;
      this.record({
        kind: "browser_network_error",
        ...request,
        message:
          event.errorText.match(/net::[A-Z0-9_]+/)?.[0] ?? "request failed",
        blockedReason: event.blockedReason,
        corsError: event.corsErrorStatus?.corsError,
      });
    });
    await session.send("Network.enable");
  }

  resourceError(): HarnessError | undefined {
    if (!this.failures.size) return;
    const resources = [...this.failures.values()]
      .slice(0, 5)
      .map(
        (event) =>
          `${event.resourceType} ${event.url} (${event.message ?? `HTTP ${event.status}`})`,
      )
      .join("; ");
    return new HarnessError(
      "PAGE_RESOURCES_FAILED",
      `The page could not render and scripts/styles failed: ${resources}. Inspect browser_network_error events for blockedReason/corsError. If local-network access was denied behind a VPN, use --allow-local-network-origin with the requesting page origin. Check proxy, VPN/DNS and certificate trust for other failures.`,
    );
  }

  async blankPageError(): Promise<HarnessError | undefined> {
    if (!this.page || !this.failures.size) return;
    const hasContent = await this.page.locator("body").evaluate((body) => {
      if (((body as HTMLElement).innerText ?? "").trim()) return true;
      return [
        ...body.querySelectorAll(
          "input,textarea,select,button,img,svg,canvas,iframe,[contenteditable]",
        ),
      ].some((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          getComputedStyle(element).visibility !== "hidden"
        );
      });
    });
    if (!hasContent) return this.resourceError();
  }
}

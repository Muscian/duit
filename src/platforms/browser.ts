import "../load-env.js";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  chromium,
  firefox,
  webkit,
  expect,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  HarnessError,
  type ElementCandidate,
  type CompiledStep,
  type PlatformDiagnostics,
  type LocatorSpec,
  type Observation,
  type PlatformAdapter,
  type ResolvedAction,
  type VisualFrame,
} from "../core/types.js";

import { browserConnection, diagnosticUrl } from "./browser-network.js";
import { BrowserNetworkDiagnostics } from "./browser-diagnostics.js";
import { compatible } from "../core/decisions.js";

type DomCandidate = Omit<ElementCandidate, "id" | "locator"> & {
  css: string;
  testId: string | null;
  label: string;
};
export type BrowserOptions = {
  proxy?: string;
  channel?: "chrome" | "msedge" | "chromium";
  localNetworkOrigins?: string[];
  browser?: "chromium" | "firefox" | "webkit";
  headed?: boolean;
  timeoutMs?: number;
  navigationTimeoutMs?: number;
  allowedOrigins?: string[];
  storageState?: string;
  tracePath?: string;
  maskValues?: string[];
  viewport?: { width: number; height: number };
};
export class BrowserAdapter implements PlatformAdapter {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private origins = new Set<string>();
  private blockedNavigation?: string;
  private baseUrl = "";
  private popupTasks: Promise<void>[] = [];
  private opening = true;
  private interruptionHandler?: () => Promise<void>;
  private handlerContext = new AsyncLocalStorage<boolean>();
  private activeAction?: {
    settled: boolean;
    error?: unknown;
    done: Promise<void>;
    release: () => void;
  };
  private async withActionFence(action: () => Promise<void>) {
    if (this.handlerContext.getStore()) return action();
    let release!: () => void;
    const state = {
      settled: false,
      error: undefined as unknown,
      done: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
    };
    this.activeAction = state;
    try {
      await action();
    } catch (error) {
      throw state.error ?? error;
    } finally {
      state.settled = true;
      state.release();
      if (this.activeAction === state) this.activeAction = undefined;
    }
  }
  setInterruptionHandler(handler: () => Promise<void>) {
    this.interruptionHandler = handler;
  }
  private async attachInterruptionHandler(page: Page) {
    if (this.interruptionHandler)
      await page.addLocatorHandler(
        page.locator("body"),
        async () => {
          const action = this.activeAction;
          try {
            await this.handlerContext.run(true, async () =>
              this.interruptionHandler?.(),
            );
          } catch (error) {
            // Playwright invokes handlers as async events: throwing here escapes
            // the pending action. Hold its gate until that action times out, then
            // propagate the original error through the ordinary runner boundary.
            if (action && !action.settled) {
              action.error = error;
              await action.done;
            }
          }
        },
        { noWaitAfter: true },
      );
  }
  private disposed = false;
  private diagnosticState: PlatformDiagnostics = { events: [] };
  private network = new BrowserNetworkDiagnostics((event) =>
    this.networkEvent(event),
  );
  diagnostics(): PlatformDiagnostics {
    return {
      ...this.diagnosticState,
      url: this.page
        ? diagnosticUrl(this.page.url())
        : this.diagnosticState.url,
      events: [...this.diagnosticState.events],
    };
  }
  private networkEvent(event: PlatformDiagnostics["events"][number]) {
    this.diagnosticState.events.push(event);
    if (this.diagnosticState.events.length > 100)
      this.diagnosticState.events.shift();
  }
  constructor(private options: BrowserOptions = {}) {}
  async open(url: string) {
    if (this.disposed)
      throw new HarnessError(
        "BROWSER_CLOSED",
        "Use a new adapter for each run",
      );
    this.baseUrl = url;
    this.origins = new Set([
      new URL(url).origin,
      ...(this.options.allowedOrigins ?? []).map((s) => new URL(s).origin),
    ]);
    if (
      this.options.channel &&
      (this.options.browser ?? "chromium") !== "chromium"
    )
      throw new HarnessError(
        "INVALID_BROWSER_OPTIONS",
        "--channel requires --browser chromium",
      );
    const localNetworkOrigins = [
      ...new Set(
        (this.options.localNetworkOrigins ?? []).map((value) => {
          const parsed = new URL(value);
          if (
            !["http:", "https:"].includes(parsed.protocol) ||
            !this.origins.has(parsed.origin)
          )
            throw new HarnessError(
              "INVALID_BROWSER_OPTIONS",
              "Local-network permission requires a baseUrl or --allow-origin HTTP(S) origin",
            );
          return parsed.origin;
        }),
      ),
    ];
    const { connection, proxy } = browserConnection(url, this.options.proxy);
    this.diagnosticState = { url: diagnosticUrl(url), connection, events: [] };
    this.browser = await { chromium, firefox, webkit }[
      this.options.browser ?? "chromium"
    ].launch({
      headless: !this.options.headed,
      proxy,
      channel: this.options.channel,
    });
    if (this.disposed) {
      await this.browser.close();
      throw new HarnessError("RUN_CANCELLED", "Browser start was cancelled");
    }
    this.context = await this.browser.newContext({
      viewport: this.options.viewport ?? { width: 1280, height: 800 },
      storageState: this.options.storageState,
      serviceWorkers: "block",
    });
    this.diagnosticState.browser = {
      name: this.options.browser ?? "chromium",
      version: this.browser.version(),
      channel: this.options.channel,
      localNetworkOrigins,
    };
    for (const origin of localNetworkOrigins) {
      try {
        await this.context.grantPermissions(["local-network-access"], {
          origin,
        });
      } catch {
        throw new HarnessError(
          "LOCAL_NETWORK_PERMISSION_UNSUPPORTED",
          "This browser cannot grant local-network-access; update Playwright/browser or select a supported Chromium channel",
        );
      }
    }
    this.context.setDefaultTimeout(this.options.timeoutMs ?? 5000);
    this.context.setDefaultNavigationTimeout(
      this.options.navigationTimeoutMs ?? 30_000,
    );
    this.network.attach(this.context);
    await this.context.route("**/*", async (route) => {
      const req = route.request();
      if (
        req.isNavigationRequest() &&
        !this.origins.has(new URL(req.url()).origin)
      ) {
        this.blockedNavigation = new URL(req.url()).origin;
        this.networkEvent({
          kind: "navigation_blocked",
          url: diagnosticUrl(req.url()),
        });
        await route.abort("blockedbyclient");
      } else await route.continue();
    });
    if (this.options.tracePath)
      await this.context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: false,
      });
    this.page = await this.context.newPage();
    await this.network.attachPage(
      this.page,
      (this.options.browser ?? "chromium") === "chromium",
    );
    await this.navigate(url);
    await this.attachInterruptionHandler(this.page);
    this.opening = false;
    this.context.on("page", (popup) => {
      if (this.opening) return;
      const task = (async () => {
        await this.network.attachPage(
          popup,
          (this.options.browser ?? "chromium") === "chromium",
        );
        await popup.waitForURL(
          (value) => value.protocol === "https:" || value.protocol === "http:",
          { timeout: this.options.navigationTimeoutMs ?? 30000 },
        );
        if (!this.origins.has(new URL(popup.url()).origin))
          throw new HarnessError(
            "NAVIGATION_BLOCKED",
            "New window is outside allowed origins",
          );
        await popup.waitForLoadState("domcontentloaded");
        await this.attachInterruptionHandler(popup);
        this.page = popup;
      })();
      // Retain rejection for the next operation without an unhandled rejection.
      void task.catch(() => {});
      this.popupTasks.push(task);
    });
  }
  private current(): Page {
    if (!this.page)
      throw new HarnessError("BROWSER_CLOSED", "Browser is not open");
    return this.page;
  }
  async refresh(controlName?: string) {
    if (!controlName) {
      await this.navigate(this.current().url(), true);
      return;
    }
    const observation = await this.observe();
    const matches = observation.elements.filter(
      (element) =>
        element.role === "button" &&
        element.name === controlName &&
        element.visible &&
        !element.blockedByModal &&
        !element.disabled,
    );
    if (matches.length !== 1)
      throw new HarnessError(
        "REFRESH_CONTROL_UNAVAILABLE",
        `Expected one visible refresh button named ${JSON.stringify(controlName)}, found ${matches.length}`,
      );
    const action: ResolvedAction = {
      text: `Refresh using ${controlName}`,
      operation: "click",
      target: matches[0].locator,
      resolution: "exact-label",
    };
    await this.prepare(action);
    await this.execute(action);
  }
  private async navigate(url: string, reload = false) {
    this.blockedNavigation = undefined;
    try {
      const response = reload
        ? await this.current().reload({ waitUntil: "domcontentloaded" })
        : await this.current().goto(url, { waitUntil: "domcontentloaded" });
      if (response && response.status() >= 400)
        throw new HarnessError(
          "HTTP_NAVIGATION_ERROR",
          `HTTP ${response.status()} loading ${diagnosticUrl(url)}; inspect report network diagnostics`,
        );
    } catch (error) {
      if (this.blockedNavigation)
        throw new HarnessError(
          "NAVIGATION_BLOCKED",
          `Navigation to ${this.blockedNavigation} is outside allowed origins`,
        );
      if (error instanceof HarnessError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && error.name === "TimeoutError")
        throw new HarnessError(
          "NAVIGATION_TIMEOUT",
          `Loading ${diagnosticUrl(url)} exceeded the navigation timeout; check proxy/network and --navigation-timeout`,
        );
      const code = message.match(/net::[A-Z_]+/)?.[0] ?? "navigation failed";
      throw new HarnessError(
        "BROWSER_CONNECTION_FAILED",
        `${code} loading ${diagnosticUrl(url)}; check HTTP(S)_PROXY, NO_PROXY or --proxy. See report network diagnostics.`,
      );
    }
  }
  private async settlePopups() {
    while (this.popupTasks.length) {
      try {
        await this.popupTasks.shift();
      } catch (error) {
        if (this.blockedNavigation)
          throw new HarnessError(
            "NAVIGATION_BLOCKED",
            `Navigation to ${this.blockedNavigation} is outside allowed origins; add it to allowedOrigins before the next run`,
          );
        throw error;
      }
    }
  }
  async observe(step?: CompiledStep): Promise<Observation> {
    await this.settlePopups();
    if (!step) {
      const observation = await this.snapshot();
      const resourceError = await this.network.blankPageError();
      if (resourceError) throw resourceError;
      return observation;
    }
    const page = this.current();
    const deadline = Date.now() + (this.options.navigationTimeoutMs ?? 30_000);
    // DOMContentLoaded does not mean that a SPA has rendered its form.
    // Poll only observations; decisions and UI actions are never retried here.
    do {
      this.current();
      try {
        const observation = await this.snapshot();
        if (
          observation.elements.some((element) =>
            compatible(step.operation, element),
          )
        )
          return observation;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/Execution context was destroyed|Cannot find context|Frame was detached/.test(
            error.message,
          )
        )
          throw error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Closing the browser on cancellation interrupts this short wait immediately.
      await page.waitForTimeout(Math.min(250, remaining));
    } while (Date.now() < deadline);
    const resourceError = this.network.resourceError();
    if (resourceError) throw resourceError;
    throw new HarnessError(
      "PAGE_NOT_READY",
      `No eligible controls appeared for ${step.operation} at ${diagnosticUrl(page.url())}; inspect network diagnostics or increase --navigation-timeout`,
    );
  }
  private async snapshot(): Promise<Observation> {
    const page = this.current();
    const elements: ElementCandidate[] = [];
    const frames = page.frames();
    for (const [index, frame] of frames.entries()) {
      // Static code only: Function avoids transpiler-injected closures when Playwright serializes it.
      // Neither the user nor the model can provide executable JavaScript.
      const candidates = await frame
        .locator(
          'input,textarea,select,button,a,summary,[role],[tabindex],[onclick],[contenteditable="true"],h1,h2,h3,h4,label,p,li,td,[data-testid],div,span',
        )
        .evaluateAll(
          new Function(
            "nodes",
            String.raw`
        const selector = (el) => {
          if (el.id) return '#' + CSS.escape(el.id);
          const tag = el.localName;
          const parent = el.parentElement;
          const root = el.getRootNode();
          if (!parent) return root instanceof ShadowRoot ? selector(root.host) + ' ' + tag : tag;
          const siblings = Array.from(parent.children).filter(n => n.localName === tag);
          return selector(parent) + ' > ' + tag + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(el)+1) + ')' : '');
        };
        const semantic = 'input,textarea,select,button,a,summary,[role],[tabindex],[onclick],[contenteditable="true"],h1,h2,h3,h4,label,p,li,td,[data-testid]';
        const parentOf = (el) => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
        const ancestors = (el) => { const result=[]; for(let p=parentOf(el);p;p=parentOf(p)) result.push(p); return result; };
        return nodes.filter(el => el.matches(semantic) || (getComputedStyle(el).cursor === 'pointer' && !el.querySelector('button,a,[role="button"],[role="link"],div,span') && !ancestors(el).some(p=>p.matches('button,a,[role="button"],[role="link"],[tabindex],[onclick]')) && (el.textContent || '').trim().length > 0 && (el.textContent || '').trim().length < 200)).map(el => {
          const node = el;
          const input = el;
          const tag = el.localName;
          const type = el.getAttribute('type') ?? '';
          const label = Array.from(input.labels ?? []).map(n => n.textContent?.trim()).join(' ');
          const labelled = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => (el.getRootNode().getElementById?.(id) || el.ownerDocument.getElementById(id))?.textContent ?? '').join(' ').trim();
          const text = (node.innerText ?? el.textContent ?? '').trim().replace(/\s+/g,' ').slice(0,300);
          const name = (el.getAttribute('aria-label') || labelled || label || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || (['submit','button','reset'].includes(type) ? input.value : '') || (['input','textarea','select'].includes(tag) ? '' : text)).slice(0,300);
          const role = el.getAttribute('role') || ({ button:'button', a:'link', select:'combobox', textarea:'textbox', summary:'button', h1:'heading',h2:'heading',h3:'heading',h4:'heading',li:'listitem' }[tag] ?? (tag === 'input' ? (['checkbox','radio'].includes(type) ? type : ['submit','button','reset'].includes(type) ? 'button' : 'textbox') : ((el.hasAttribute('onclick') || el.tabIndex >= 0 || getComputedStyle(el).cursor === 'pointer') && !ancestors(el).some(p=>p.matches('button,a,[role="button"],[role="link"],[tabindex],[onclick]'))) ? 'button' : ''));
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const parents = ancestors(el);
          const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && ![el,...parents].some(n => n.hasAttribute('inert') || n.getAttribute('aria-hidden') === 'true');
          const x=Math.max(0,Math.min(innerWidth-1,rect.x+rect.width/2)), y=Math.max(0,Math.min(innerHeight-1,rect.y+rect.height/2));
          const inViewport=rect.right>0 && rect.bottom>0 && rect.left<innerWidth && rect.top<innerHeight;
          let hit = document.elementFromPoint(x,y);
          while(hit?.shadowRoot?.elementFromPoint(x,y) && hit.shadowRoot.elementFromPoint(x,y)!==hit) hit=hit.shadowRoot.elementFromPoint(x,y);
          const occluded = visible && inViewport && !!hit && hit !== el && !el.contains(hit) && !ancestors(hit).includes(el);
          const overlayNode=[el,...parents].find(n=>n.matches('dialog,[role="dialog"],[aria-modal="true"]'));
          const overlay=overlayNode ? (overlayNode.getAttribute('aria-label') || overlayNode.querySelector('h1,h2,h3,[role="heading"]')?.textContent || overlayNode.innerText || '').trim().replace(/\s+/g,' ').slice(0,300) : undefined;
          const container = el.closest('tr,[role="row"],fieldset,article,[role="group"],button,[role="button"]') || el.parentElement?.parentElement || el.parentElement;
          const headings=parents.slice(0,8).flatMap(p=>Array.from(p.children).filter(n=>!n.contains(el) && (n.matches('h1,h2,h3,h4,legend,label') || (n.matches('div,span') && !n.querySelector('input,textarea,select,button,a,[role=button]') && (n.innerText??'').trim().length<160))).map(n=>(n.innerText??n.textContent??'').trim())).filter(Boolean);
          let fieldGroup;
          if(['input','textarea','select'].includes(tag)) {
            let count;
            for(const p of parents) {
              const n=p.querySelectorAll('input,textarea,select').length;
              if(n>1 && count===undefined)count=n;
              if(count!==undefined && n!==count)break;
              if(n===count && !p.matches('body,html') && (p.innerText??'').length<1400)fieldGroup=p;
            }
          }
          const row=el.closest('tr,[role="row"]');
          const rowContext=row?.parentElement ? 'Row '+(Array.from(row.parentElement.children).filter(n=>n.matches('tr,[role="row"]')).indexOf(row)+1)+': '+(row.innerText??'').trim().replace(/\s+/g,' ') : undefined;
          const context=[...new Set([...(rowContext?[rowContext]:[]),...headings,...(fieldGroup?[(fieldGroup.innerText??'').trim().replace(/\s+/g,' ')]:[]),(container?.innerText ?? '').trim().replace(/\s+/g,' ')])].join(' | ').slice(0,1400);
          return { tag, role, name, text: ['input','textarea','select'].includes(tag) ? '' : text, type,
            disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true', visible,
            checked: ['checkbox','radio'].includes(type) ? input.checked : ['checkbox','radio','switch'].includes(role) ? el.getAttribute('aria-checked') === 'true' : undefined,
            occluded, overlay, href: el.hasAttribute('href') ? el.href : undefined,
            options: tag === 'select' ? Array.from(el.options).map(o => o.label) : undefined,
            context,
            css: selector(el), testId: el.getAttribute('data-testid'), label,
          };
        });
      `,
          ) as (nodes: Element[]) => DomCandidate[],
        );
      const observed = await Promise.all(
        candidates.map(async (c) => {
          let spec: LocatorSpec = { frame: index, kind: "css", value: c.css };
          if (c.testId && (await frame.getByTestId(c.testId).count()) === 1)
            spec = { frame: index, kind: "testId", value: c.testId };
          else if (
            c.label &&
            (await frame.getByLabel(c.label, { exact: true }).count()) === 1
          )
            spec = { frame: index, kind: "label", value: c.label };
          else if (
            c.role &&
            c.name &&
            (await frame
              .getByRole(c.role as Parameters<Frame["getByRole"]>[0], {
                name: c.name,
                exact: true,
              })
              .count()) === 1
          )
            spec = { frame: index, kind: "role", value: c.role, name: c.name };
          // Do not expose selectors/test data values to the model. Only the safe descriptive fields go to Jev.
          const { css: _css, testId: _testId, label: _label, ...data } = c;
          if (data.href) data.href = diagnosticUrl(data.href);
          return { ...data, locator: spec };
        }),
      );
      for (const element of observed)
        elements.push({ ...element, id: `e${elements.length}` });
    }
    const activeOverlays = new Set(
      elements
        .filter(
          (e) =>
            e.visible &&
            !e.occluded &&
            e.overlay &&
            ["button", "link"].includes(e.role),
        )
        .map((e) => e.overlay),
    );
    if (activeOverlays.size)
      for (const element of elements)
        if (!element.overlay) {
          element.occluded = true;
          element.blockedByModal = true;
        }
    const text = (await page.locator("body").innerText()).slice(0, 16000);
    return {
      url: page.url(),
      title: await page.title(),
      text,
      dialogs: [
        ...new Set(
          elements.filter((e) => e.visible && e.overlay).map((e) => e.overlay!),
        ),
      ],
      elements,
    };
  }
  private locator(spec: LocatorSpec): Locator {
    const frame = this.current().frames()[spec.frame];
    if (!frame)
      throw new HarnessError("STALE_FRAME", "Target frame no longer exists");
    switch (spec.kind) {
      case "testId":
        return frame.getByTestId(spec.value);
      case "label":
        return frame.getByLabel(spec.value, { exact: true });
      case "role":
        return frame.getByRole(
          spec.value as Parameters<Frame["getByRole"]>[0],
          { name: spec.name, exact: true },
        );
      case "css":
        return frame.locator(spec.value);
    }
  }
  async prepare(action: ResolvedAction): Promise<void> {
    return this.withActionFence(() => this.prepareAction(action));
  }
  private async prepareAction(action: ResolvedAction): Promise<void> {
    await this.settlePopups();
    if (action.visualTarget) {
      await this.validateVisual(action);
      return;
    }
    if (!action.target || action.operation.startsWith("assert_")) return;
    const target = this.locator(action.target);
    try {
      await expect(target).toHaveCount(1, {
        timeout: this.options.timeoutMs ?? 5000,
      });
      await target.click({
        trial: true,
        timeout: this.options.timeoutMs ?? 5000,
      });
    } catch {
      throw new HarnessError(
        "UI_NOT_ACTIONABLE",
        `The selected ${action.operation} control is not uniquely actionable. Inspect dialogs, visibility, disabled state and current page before retrying.`,
      );
    }
  }
  async execute(action: ResolvedAction): Promise<void> {
    return this.withActionFence(() => this.executeWithChecks(action));
  }
  private async executeWithChecks(action: ResolvedAction): Promise<void> {
    const textAssertion = ["assert_text", "assert_no_text"].includes(
      action.operation,
    );
    try {
      if (action.operation === "assert_no_text") {
        const error = await this.network.blankPageError();
        if (error) throw error;
      }
      await this.settlePopups();
      this.blockedNavigation = undefined;
      const popup =
        action.operation === "click"
          ? this.current()
              .waitForEvent("popup", { timeout: 250 })
              .catch(() => undefined)
          : undefined;
      await this.executeAction(action);
      if (popup) await popup;
      await this.settlePopups();
      if (this.blockedNavigation)
        throw new HarnessError(
          "NAVIGATION_BLOCKED",
          `Navigation to ${this.blockedNavigation} is outside allowed origins`,
        );
    } catch (error) {
      if (textAssertion) {
        const resourceError = await this.network.blankPageError();
        if (resourceError) throw resourceError;
      }
      throw error;
    }
  }
  private async executeAction(action: ResolvedAction): Promise<void> {
    const page = this.current();
    const timeout = this.options.timeoutMs ?? 5000;
    const op = action.operation;
    const value = action.value ?? "";
    if (action.visualTarget) {
      await this.validateVisual(action);
      const v = action.visualTarget;
      await page.mouse.click(
        ((v.box.left + v.box.right) * v.width) / 2,
        ((v.box.top + v.box.bottom) * v.height) / 2,
      );
      return;
    }
    if (op === "goto") {
      const url = new URL(value, this.baseUrl);
      if (!this.origins.has(url.origin))
        throw new HarnessError(
          "NAVIGATION_BLOCKED",
          "URL is outside allowed origins",
        );
      await this.navigate(url.href);
    } else if (op === "assert_url") {
      await expect
        .poll(
          async () => {
            await this.settlePopups();
            return this.current().url();
          },
          { timeout },
        )
        .toBe(new URL(value, this.baseUrl).href);
    } else if (op === "assert_text" || op === "assert_no_text") {
      // Any visible exact text match suffices. Duplicate hidden templates cannot make a positive assertion pass.
      await expect
        .poll(
          async () => {
            await this.settlePopups();
            for (const frame of this.current().frames())
              for (const match of await frame
                .getByText(value, { exact: true })
                .all())
                if (await match.isVisible()) return true;
            return false;
          },
          {
            timeout,
            message: `Expected exact text to be ${op === "assert_text" ? "visible" : "absent"}`,
          },
        )
        .toBe(op === "assert_text");
    } else {
      if (!action.target)
        throw new HarnessError(
          "MISSING_TARGET",
          "Action requires a DOM target",
        );
      const target = this.locator(action.target);
      if (op !== "assert_hidden")
        await expect(target).toHaveCount(1, { timeout });
      else if ((await target.count()) > 1)
        throw new HarnessError(
          "AMBIGUOUS_TARGET",
          "Hidden assertion matches multiple elements",
        );
      switch (op) {
        case "click":
          await target.click();
          break;
        case "fill":
          await target.fill(value);
          break;
        case "select":
          await target.selectOption({ label: value });
          break;
        case "check":
          await target.check();
          break;
        case "uncheck":
          await target.uncheck();
          break;
        case "press":
          if (
            !/^(?:(?:Control|Meta|Alt|Shift)\+)*(?:Enter|Tab|Escape|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|[a-zA-Z0-9])$/.test(
              value,
            )
          )
            throw new HarnessError(
              "UNSUPPORTED_KEY",
              "Use an explicit Playwright keyboard key, such as Enter",
            );
          await target.press(value);
          break;
        case "assert_visible":
          await expect(target).toBeVisible({ timeout });
          break;
        case "assert_hidden":
          await expect(target).toBeHidden({ timeout });
          break;
        case "assert_nonempty":
          await expect(target).toHaveValue(/\S/, { timeout });
          break;
        case "assert_value":
          await expect(target).toHaveValue(value, { timeout });
          break;
        case "assert_checked":
          await expect(target).toBeChecked({ timeout });
          break;
        case "assert_unchecked":
          await expect(target).not.toBeChecked({ timeout });
          break;
        case "assert_enabled":
          await expect(target).toBeEnabled({ timeout });
          break;
        case "assert_disabled":
          await expect(target).toBeDisabled({ timeout });
          break;
      }
    }
    this.current();
  }
  async observeVisual(): Promise<VisualFrame> {
    await this.settlePopups();
    const page = this.current(),
      size = page.viewportSize();
    if (
      !size ||
      Math.min(size.width, size.height) < 280 ||
      Math.max(size.width, size.height) > 1568
    )
      throw new HarnessError(
        "VISUAL_VIEWPORT_UNSUPPORTED",
        "Visual viewport dimensions must be 280–1568 CSS pixels",
      );
    const mask = page
      .frames()
      .flatMap((frame) => [
        frame.locator('input,textarea,[contenteditable="true"]'),
        ...(this.options.maskValues ?? [])
          .filter(Boolean)
          .map((value) => frame.getByText(value, { exact: false })),
      ]);
    const bytes = await page.screenshot({
      fullPage: false,
      scale: "css",
      animations: "disabled",
      caret: "hide",
      mask,
      timeout: 5000,
    });
    const scroll = await page.evaluate(() => [window.scrollX, window.scrollY]);
    return {
      format: "png",
      dataBase64: bytes.toString("base64"),
      width: size.width,
      height: size.height,
      url: page.url(),
      revision: createHash("sha256")
        .update(bytes)
        .update(JSON.stringify([page.url(), scroll, size]))
        .digest("hex"),
    };
  }
  private async validateVisual(action: ResolvedAction) {
    const v = action.visualTarget!;
    if (action.operation !== "click")
      throw new HarnessError(
        "INVALID_VISUAL_OPERATION",
        "Visual targets support click only",
      );
    const frame = await this.observeVisual();
    if (
      frame.revision !== v.revision ||
      frame.width !== v.width ||
      frame.height !== v.height
    )
      throw new HarnessError(
        "VISUAL_FRAME_CHANGED",
        "Viewport changed after visual decision; inspect again before clicking",
      );
    const b = v.box;
    if (
      Object.values(b).some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
      b.left >= b.right ||
      b.top >= b.bottom
    )
      throw new HarnessError("INVALID_VISUAL_TARGET", "Invalid normalized box");
    const hit = await this.current().evaluate(
      ({ x, y }) => {
        const e = document.elementFromPoint(x, y);
        return !!e && !e.closest('[disabled],[aria-disabled="true"],[inert]');
      },
      {
        x: ((b.left + b.right) * v.width) / 2,
        y: ((b.top + b.bottom) * v.height) / 2,
      },
    );
    if (!hit)
      throw new HarnessError(
        "UI_NOT_ACTIONABLE",
        "Visual target is disabled or outside the page",
      );
  }
  async capture(path: string): Promise<void> {
    const page = this.current();
    const mask = page
      .frames()
      .flatMap((frame) => [
        frame.locator('input,textarea,[contenteditable="true"]'),
        ...(this.options.maskValues ?? [])
          .filter(Boolean)
          .map((value) => frame.getByText(value, { exact: false })),
      ]);
    await page.screenshot({
      path,
      fullPage: true,
      mask,
      animations: "disabled",
      timeout: 5000,
    });
  }
  async close(): Promise<void> {
    this.disposed = true;
    if (this.page) this.diagnosticState.url = diagnosticUrl(this.page.url());
    try {
      if (this.context && this.options.tracePath)
        await this.context.tracing.stop({ path: this.options.tracePath });
    } finally {
      await this.browser?.close();
      this.page = undefined;
      this.context = undefined;
      this.browser = undefined;
    }
  }
}

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
  type LocatorSpec,
  type Observation,
  type PlatformAdapter,
  type ResolvedAction,
} from "../core/types.js";

type DomCandidate = Omit<ElementCandidate, "id" | "locator"> & {
  css: string;
  testId: string | null;
  label: string;
};
export type BrowserOptions = {
  proxy?: string;
  browser?: "chromium" | "firefox" | "webkit";
  headed?: boolean;
  timeoutMs?: number;
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
  private disposed = false;
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
    this.browser = await { chromium, firefox, webkit }[
      this.options.browser ?? "chromium"
    ].launch({
      headless: !this.options.headed,
      proxy:
        (this.options.proxy ?? process.env.DUIT_BROWSER_PROXY)
          ? {
              server: (this.options.proxy ?? process.env.DUIT_BROWSER_PROXY)!,
              bypass: "localhost,127.0.0.1,[::1]",
            }
          : undefined,
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
    this.context.setDefaultTimeout(this.options.timeoutMs ?? 5000);
    this.context.setDefaultNavigationTimeout(this.options.timeoutMs ?? 5000);
    await this.context.route("**/*", async (route) => {
      const req = route.request();
      if (
        req.isNavigationRequest() &&
        !this.origins.has(new URL(req.url()).origin)
      ) {
        this.blockedNavigation = new URL(req.url()).origin;
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
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }
  private current(): Page {
    if (!this.page)
      throw new HarnessError("BROWSER_CLOSED", "Browser is not open");
    if (this.blockedNavigation)
      throw new HarnessError(
        "NAVIGATION_BLOCKED",
        `Navigation to ${this.blockedNavigation} is outside allowed origins`,
      );
    if (this.context!.pages().length !== 1)
      throw new HarnessError(
        "MULTIPLE_PAGES",
        "Popups/new tabs are not supported in this PoC",
      );
    return this.page;
  }
  async observe(): Promise<Observation> {
    const page = this.current();
    const elements: ElementCandidate[] = [];
    const frames = page.frames();
    for (const [index, frame] of frames.entries()) {
      // Static code only: Function avoids transpiler-injected closures when Playwright serializes it.
      // Neither the user nor the model can provide executable JavaScript.
      const candidates = await frame
        .locator(
          'input,textarea,select,button,a[href],summary,[role],[contenteditable="true"],h1,h2,h3,h4,label,p,li,td,[data-testid]',
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
        return nodes.map(el => {
          const node = el;
          const input = el;
          const tag = el.localName;
          const type = el.getAttribute('type') ?? '';
          const label = Array.from(input.labels ?? []).map(n => n.textContent?.trim()).join(' ');
          const labelled = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').trim();
          const text = (node.innerText ?? el.textContent ?? '').trim().replace(/\s+/g,' ').slice(0,300);
          const name = (el.getAttribute('aria-label') || labelled || label || el.getAttribute('alt') || el.getAttribute('placeholder') || (['submit','button','reset'].includes(type) ? input.value : '') || (['input','textarea','select'].includes(tag) ? '' : text)).slice(0,300);
          const role = el.getAttribute('role') || ({ button:'button', a:'link', select:'combobox', textarea:'textbox', summary:'button', h1:'heading',h2:'heading',h3:'heading',h4:'heading',li:'listitem' }[tag] ?? (tag === 'input' ? (['checkbox','radio'].includes(type) ? type : ['submit','button','reset'].includes(type) ? 'button' : 'textbox') : ''));
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          const container = el.closest('tr,li,fieldset,article,section,form') || el.parentElement?.parentElement || el.parentElement;
          return { tag, role, name, text: ['input','textarea','select'].includes(tag) ? '' : text, type,
            disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true', visible,
            checked: ['checkbox','radio'].includes(type) ? input.checked : undefined,
            options: tag === 'select' ? Array.from(el.options).map(o => o.label) : undefined,
            context: (container?.innerText ?? '').trim().replace(/\s+/g,' ').slice(0,400),
            css: selector(el), testId: el.getAttribute('data-testid'), label,
          };
        });
      `,
          ) as (nodes: Element[]) => DomCandidate[],
        );
      for (const c of candidates) {
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
        elements.push({ ...data, id: `e${elements.length}`, locator: spec });
      }
    }
    return { url: page.url(), title: await page.title(), elements };
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
  async execute(action: ResolvedAction): Promise<void> {
    const page = this.current();
    const timeout = this.options.timeoutMs ?? 5000;
    const op = action.operation;
    const value = action.value ?? "";
    if (op === "goto") {
      const url = new URL(value, this.baseUrl);
      if (!this.origins.has(url.origin))
        throw new HarnessError(
          "NAVIGATION_BLOCKED",
          "URL is outside allowed origins",
        );
      await page.goto(url.href, { waitUntil: "domcontentloaded" });
    } else if (op === "assert_url") {
      await expect(page).toHaveURL(new URL(value, this.baseUrl).href, {
        timeout,
      });
    } else if (op === "assert_text" || op === "assert_no_text") {
      // Any visible exact text match suffices. Duplicate hidden templates cannot make a positive assertion pass.
      await expect
        .poll(
          async () => {
            for (const frame of page.frames())
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

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import path from "node:path";
import fs from "node:fs";

export interface InteractiveElement {
  ref: number;
  role: string;
  name: string;
  selector: string;
  tag: string;
  value?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: InteractiveElement[];
  summaryText: string;
}

type BrowserMode = "system-browser" | "cdp" | "persistent";

export class BrowserService {
  private static instance: BrowserService | null = null;

  private browser: Browser | null = null;
  private context: BrowserContext | undefined = undefined;
  private activePage: Page | null = null;
  private readonly cdpPort = 9223;
  private mode: BrowserMode | null = null;
  private detectedChannel: string = "chrome";
  private readonly userDataDir = path.resolve(
    process.cwd(),
    ".openclaw",
    "browser-data"
  );
  private lastElementMap = new Map<number, string>();
  private initPromise: Promise<string> | null = null;

  private constructor() { }

  public static getInstance(): BrowserService {
    if (!BrowserService.instance) {
      BrowserService.instance = new BrowserService();
    }
    return BrowserService.instance;
  }

  /**
   * Initializes the browser engine.
   *
   * By default (`preferCdp = false`), it launches the user's installed Google Chrome
   * (or Edge as a zero-config fallback) directly via Playwright's system channel.
   * This bypasses the need to manually start Chrome with remote debugging flags or
   * download a 400MB Playwright Chromium binary.
   *
   * If `preferCdp = true` is explicitly passed, it attempts to hook into an active
   * Chrome CDP port (9223) with a short timeout before falling back to the installed browser.
   */
  public async init(preferCdp = false): Promise<string> {
    if (
      this.context &&
      this.activePage &&
      !this.activePage.isClosed() &&
      (this.mode === "system-browser" || this.mode === "persistent" || this.browser?.isConnected())
    ) {
      return `Browser is ready (${this.mode} mode).`;
    }

    // Prevent two simultaneous tool calls from launching multiple browsers.
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initialize(preferCdp);
    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async initialize(preferCdp: boolean): Promise<string> {
    // 1. Optional CDP attach if explicitly requested
    if (preferCdp) {
      try {
        const endpoint = `http://127.0.0.1:${this.cdpPort}`;
        this.browser = await chromium.connectOverCDP(endpoint, {
          timeout: 3_000, // Short timeout to avoid hanging when CDP is not running
        });

        const contexts = this.browser.contexts();
        if (!contexts.length) {
          throw new Error("Chrome CDP connected but exposed no browser context.");
        }

        this.context = contexts[0];
        this.mode = "cdp";

        this.activePage = await this.context!.newPage();
        this.attachPageDiagnostics(this.activePage);

        return `Connected to Chrome via CDP on port ${this.cdpPort}. Opened a new agent tab.`;
      } catch (error) {
        console.warn(
          `[BrowserService] CDP connection failed on port ${this.cdpPort}; launching installed system browser instead: ${this.errorMessage(error)}`
        );
        await this.resetReferences();
      }
    }

    // 2. Default: Launch user's installed system browser with persistent session
    return await this.launchSystemBrowser();
  }

  /**
   * Launches the user's installed Chrome or Edge directly using persistent context.
   * Enables anti-detection flags so web applications do not flag the agent as a bot.
   */
  private async launchSystemBrowser(): Promise<string> {
    fs.mkdirSync(this.userDataDir, { recursive: true });

    // Priority channels: Google Chrome -> Microsoft Edge (built-in on Windows) -> fallback Chromium
    const candidateChannels: Array<"chrome" | "msedge" | undefined> = [
      "chrome",
      "msedge",
      undefined,
    ];

    let lastError: unknown = null;

    for (const channel of candidateChannels) {
      const channelLabel = channel ?? "bundled-chromium";
      try {
        this.context = await chromium.launchPersistentContext(this.userDataDir, {
          channel,
          headless: false,
          viewport: null, // Natural window scaling without scroll clipping
          args: [
            "--start-maximized",
            // Removes the navigator.webdriver property so bot protections don't trigger
            "--disable-blink-features=AutomationControlled",
            "--no-default-browser-check",
            "--no-first-run",
          ],
          // Removes the "Chrome is being controlled by automated test software" bar
          ignoreDefaultArgs: ["--enable-automation"],
          timeout: 20000,
        });

        this.mode = "system-browser";
        this.detectedChannel = channelLabel;
        this.browser = null;

        // Reuse an existing tab if restored from previous session, else create one
        const pages = this.context.pages();
        this.activePage =
          pages.find((page) => !page.isClosed() && page.url() !== "about:blank") ??
          pages.find((page) => !page.isClosed()) ??
          (await this.context.newPage());

        this.attachPageDiagnostics(this.activePage);
        return `Launched installed browser (${this.detectedChannel}) with persistent profile at ${this.userDataDir}.`;
      } catch (error) {
        lastError = error;
        console.warn(
          `[BrowserService] Channel '${channelLabel}' unavailable: ${this.errorMessage(error)}. Trying fallback channel...`
        );
      }
    }

    await this.resetReferences();
    throw new Error(
      `Could not start any system browser (Chrome/Edge/Chromium): ${this.errorMessage(lastError)}`
    );
  }

  private attachPageDiagnostics(page: Page): void {
    page.on("pageerror", (error) => {
      console.warn("[BrowserService] Page JavaScript error:", error.message);
    });
    page.on("crash", () => {
      console.warn("[BrowserService] Active page crashed.");
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async resetReferences(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => undefined);
    } else if (this.browser) {
      await this.browser.close().catch(() => undefined);
    }

    this.browser = null;
    this.context = undefined;
    this.activePage = null;
    this.mode = null;
    this.lastElementMap.clear();
  }

  public async getPage(): Promise<Page> {
    if (!this.context || !this.mode) {
      console.log("Stating from Init")
      await this.init();
    }

    if (!this.context) {
      throw new Error("Browser initialization completed without a context.");
    }

    if (!this.activePage || this.activePage.isClosed()) {
      const pages = this.context.pages().filter((page) => !page.isClosed());
      this.activePage =
        pages.find((page) => page.url() !== "about:blank") ??
        pages[0] ??
        (await this.context.newPage());
      this.attachPageDiagnostics(this.activePage);
    }

    return this.activePage;
  }

  private normalizeUrl(url: string): string {
    const trimmed = url.trim();
    if (!trimmed) throw new Error("URL cannot be empty.");
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  public async navigate(url: string): Promise<string> {
    const formattedUrl = this.normalizeUrl(url);
    let page = await this.getPage();

    try {
      await page.goto(formattedUrl, {
        waitUntil: "commit",
        timeout: 20000,
      });
    } catch (error) {
      const message = this.errorMessage(error);

      // ERR_ABORTED often means this tab's navigation was replaced or
      // interrupted. Retry once on a fresh tab instead of hanging forever.
      if (!message.includes("ERR_ABORTED") || !this.context) {
        throw new Error(`Navigation to ${formattedUrl} failed: ${message}`);
      }

      console.warn(
        `[BrowserService] Navigation was aborted in the current tab; retrying once in a new tab.`
      );
      page = await this.context.newPage();
      this.activePage = page;
      this.attachPageDiagnostics(page);

      try {
        await page.goto(formattedUrl, {
          waitUntil: "commit",
          timeout: 20000,
        });
      } catch (retryError) {
        throw new Error(
          `Navigation to ${formattedUrl} failed after one retry: ${this.errorMessage(retryError)}`
        );
      }
    }

    // Do not wait indefinitely for sites that keep loading analytics or ads.
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(
      () => undefined
    );
    const title = await page.title().catch(() => "");
    return `Navigated to ${page.url()}${title ? ` | Title: "${title}"` : ""}`;
  }

  public async getSnapshot(): Promise<PageSnapshot> {
    const page = await this.getPage();
    await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(
      () => undefined
    );

    // Extraction routine wrapped so it can recover if a live navigation occurs mid-execution
    const extractPageData = async () => {
      const url = page.url();
      const title = await page.title().catch(() => "");

      const rawElements = await page.evaluate(() => {
        const selectors = [
          "button",
          "a[href]",
          "input",
          "textarea",
          "select",
          "[role='button']",
          "[role='link']",
          "[role='textbox']",
          "[role='checkbox']",
        ];

        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(selectors.join(","))
        );

        function cssPath(el: HTMLElement): string {
          if (el.id) return `#${CSS.escape(el.id)}`;

          const parts: string[] = [];
          let current: HTMLElement | null = el;

          while (
            current &&
            current !== document.body &&
            current.parentElement
          ) {
            const tag = current.tagName.toLowerCase();
            const sameTagSiblings = Array.from(current.parentElement.children)
              .filter((child) => child.tagName === current!.tagName);
            const nth = sameTagSiblings.indexOf(current) + 1;
            parts.unshift(`${tag}:nth-of-type(${nth})`);
            current = current.parentElement;
          }

          return `body > ${parts.join(" > ")}`;
        }

        return nodes
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              style.opacity !== "0"
            );
          })
          .slice(0, 75)
          .map((el, index) => {
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute("role") || tag;
            const input = el as HTMLInputElement;
            const name =
              el.innerText?.trim() ||
              el.getAttribute("aria-label") ||
              el.getAttribute("placeholder") ||
              el.getAttribute("title") ||
              el.getAttribute("name") ||
              "";

            return {
              ref: index + 1,
              role,
              name: name.replace(/\s+/g, " ").slice(0, 80),
              selector: cssPath(el),
              tag,
              value: input.value || undefined,
            };
          });
      });

      this.lastElementMap.clear();
      for (const element of rawElements) {
        this.lastElementMap.set(element.ref, element.selector);
      }

      const summaryText = await page
        .evaluate(() => {
          if (!document.body) return "";
          const clone = document.body.cloneNode(true) as HTMLElement;
          clone
            .querySelectorAll("script,style,noscript,svg,nav,footer")
            .forEach((element) => element.remove());
          return (clone.innerText || "")
            .replace(/\n{3,}/g, "\n\n")
            .trim()
            .slice(0, 1500);
        })
        .catch(() => "");

      return { url, title, elements: rawElements, summaryText };
    };

    try {
      return await extractPageData();
    } catch (err) {
      // If a navigation occurred concurrently, wait for the new page context and retry once
      const msg = this.errorMessage(err);
      if (msg.includes("Execution context was destroyed") || msg.includes("navigating")) {
        await page.waitForLoadState("domcontentloaded", { timeout: 7000 }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 600));
        return await extractPageData();
      }
      throw err;
    }
  }

  private resolveSelector(refOrSelector: number | string): string {
    if (typeof refOrSelector === "string") return refOrSelector;
    const selector = this.lastElementMap.get(refOrSelector);
    if (!selector) {
      throw new Error(
        `Element ref [${refOrSelector}] not found. Run browser_snapshot again; refs expire when the page changes.`
      );
    }
    return selector;
  }

  public async click(refOrSelector: number | string): Promise<string> {
    const page = await this.getPage();
    const selector = this.resolveSelector(refOrSelector);
    const locator = page.locator(selector).first();

    await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
    await locator.click({ timeout: 7000 });
    return `Successfully clicked element: "${selector}"`;
  }

  public async fill(
    refOrSelector: number | string,
    text: string
  ): Promise<string> {
    const page = await this.getPage();
    const selector = this.resolveSelector(refOrSelector);
    const locator = page.locator(selector).first();

    await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
    await locator.fill(text, { timeout: 7000 });
    return `Filled text into element: "${selector}"`;
  }

  public async pressKey(key: string): Promise<string> {
    const page = await this.getPage();
    await page.keyboard.press(key);
    return `Pressed key: ${key}`;
  }

  public async takesScreenshot(outputPath?: string): Promise<string> {
    const page = await this.getPage();
    const dest =
      outputPath ??
      path.resolve(
        process.cwd(),
        ".openclaw",
        `screenshot-${Date.now()}.png`
      );

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await page.screenshot({ path: dest, fullPage: false, timeout: 10000 });
    return `Screenshot saved to: ${dest}`;
  }

  public async close(): Promise<string> {
    const currentMode = this.mode;
    const channel = this.detectedChannel;

    if (this.context) {
      await this.context.close().catch(() => undefined);
    } else if (this.browser) {
      await this.browser.close().catch(() => undefined);
    }

    this.browser = null;
    this.context = undefined;
    this.activePage = null;
    this.mode = null;
    this.lastElementMap.clear();

    return currentMode === "cdp"
      ? "Browser service disconnected."
      : `Browser closed (${channel}). Cookies and profile data are retained.`;
  }
}

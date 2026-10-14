/**
 * file: services/browser-service.ts
 * 
 * OpenClaw Browser Automation Service
 * Connects to Google Chrome via Chrome DevTools Protocol (CDP) or launches
 * a persistent browser instance. Provides high-level agent control over tabs,
 * DOM interactions, and semantic element accessibility extraction.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import fs from "node:fs";

export interface InteractiveElement{
    ref: number;
    role: string;
    name: string;
    selector: string;
    tag: string;
    value?:string;
}

export interface PageSnapshot{
    url: string;
    title: string;
    elements: InteractiveElement[];
    summaryText: string;
}

export class BrowserService{
    private static instance: BrowserService | null= null;
    private browser: Browser | null= null;
    private context: BrowserContext| null =null;
    private activePage: Page| null=null;
    private cdpPort: number=9222;
    private lastElementMap: Map<number, string>=new Map();

    private constructor(){}

    public static getInstance(): BrowserService{
        if(!BrowserService.instance){
            BrowserService.instance=new BrowserService();
        }

        return BrowserService.instance;
    }

      public async init(preferCdp = true): Promise<string> {
    if (this.context && this.activePage && !this.activePage.isClosed()) {
      return "Browser is already active and ready.";
    }

    if (preferCdp) {
      try {
        // Attempt connecting to user's active Chrome on debugging port
        this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`, {
          timeout: 3000,
        });
        const contexts = this.browser.contexts();
        this.context = contexts[0] || (await this.browser.newContext());
        const pages = this.context.pages();
        this.activePage = pages[0] || (await this.context.newPage());
        return `Connected to live Chrome via CDP on port ${this.cdpPort}. Active page: "${await this.activePage.title()}"`;
      } catch (err) {
        // If CDP connection fails (user didn't launch Chrome with debugging port), fall back to persistent context
        console.warn(`[BrowserService] Could not connect to CDP on port ${this.cdpPort}. Launching dedicated persistent session...`);
      }
    }

    // Dedicated persistent profile directory
    const userDataDir = path.resolve(process.cwd(), ".openclaw", "browser-data");
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    this.context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // Visible so the user can observe agent actions
      viewport: { width: 1280, height: 800 },
      args: ["--disable-blink-features=AutomationControlled"], // Reduces bot detection flags
    });

    const pages = this.context.pages();
    this.activePage = pages[0] || (await this.context.newPage());
    return `Launched persistent browser session in ${userDataDir}`;
  }

    public async getPage(): Promise<Page> {
    if (!this.context) {
      await this.init();
    }
    if (!this.activePage || this.activePage.isClosed()) {
      const pages = this.context!.pages();
      this.activePage = pages[0] || (await this.context!.newPage());
    }
    return this.activePage;
  }

    /**
   * Navigates the current page to a URL.
   */
  public async navigate(url: string): Promise<string> {
    const page = await this.getPage();
    const formattedUrl = url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;
    
    // domcontentloaded prevents hanging on infinite ad/analytics trackers
    await page.goto(formattedUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    const title = await page.title();
    return `Navigated to ${formattedUrl} | Title: "${title}"`;
  }
   /**
   * Captures an AI-optimized semantic snapshot of the page.
   * Instead of sending thousands of raw HTML lines to the LLM, this extracts:
   * 1. Page Title & URL
   * 2. Numbered references for interactive elements (links, buttons, inputs, textareas)
   * 3. Concise main text content
   */
  public async getSnapshot(): Promise<PageSnapshot> {
    const page = await this.getPage();
    // Ensure any in-flight navigation is settled before evaluating DOM
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    const url = page.url();
    const title = await page.title();

    // Query interactive elements from the DOM
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

      const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
      let counter = 1;

      return nodes
        .filter((el) => {
          // Filter out hidden, zero-sized, or display:none elements
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
        .slice(0, 75) // Limit to top 75 most relevant elements to conserve context tokens
        .map((el) => {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role") || tag;
          const name =
            (el as HTMLElement).innerText?.trim() ||
            el.getAttribute("aria-label") ||
            el.getAttribute("placeholder") ||
            el.getAttribute("title") ||
            el.getAttribute("name") ||
            "";

          // Generate a reliable unique CSS selector or ID
          let selector = "";
          if (el.id) {
            selector = `#${el.id}`;
          } else if (el.getAttribute("name")) {
            selector = `${tag}[name="${el.getAttribute("name")}"]`;
          } else {
            // Path selector fallback
            selector = `${tag}:has-text("${name.slice(0, 20)}")`;
          }

          const value = (el as HTMLInputElement).value || undefined;

          return {
            ref: counter++,
            role,
            name: name.replace(/\s+/g, " ").slice(0, 80),
            selector,
            tag,
            value,
          };
        });
    });

    // Cache the mapping so references [ref=1] map to exact CSS selectors
    this.lastElementMap.clear();
    for (const el of rawElements) {
      this.lastElementMap.set(el.ref, el.selector);
    }

    // Extract human-readable body text (truncated to 1500 chars)
    const summaryText = await page.evaluate(() => {
      const bodyClone = document.body.cloneNode(true) as HTMLElement;
      // Remove scripts, styles, and SVG clutter
      const dropTags = ["script", "style", "noscript", "svg", "nav", "footer"];
      for (const t of dropTags) {
        bodyClone.querySelectorAll(t).forEach((e) => e.remove());
      }
      return (bodyClone.innerText || "").replace(/\n\s*\n/g, "\n").slice(0, 1500);
    });

    return {
      url,
      title,
      elements: rawElements,
      summaryText,
    };
  }

  /**
   * Clicks an element using its numeric ref from the last snapshot or a CSS selector.
   */
  public async click(refOrSelector: number | string): Promise<string> {
    const page = await this.getPage();
    let selector = typeof refOrSelector === "number" 
      ? this.lastElementMap.get(refOrSelector) 
      : refOrSelector;

    if (!selector) {
      throw new Error(`Element ref [${refOrSelector}] not found. Run browser_snapshot first.`);
    }

    // Scroll into view and click
    await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 4000 });
    await page.locator(selector).first().click({ timeout: 5000 });

    return `Successfully clicked element: "${selector}"`;
  }

   /**
   * Types text into an input field identified by ref or selector.
   */
  public async fill(refOrSelector: number | string, text: string): Promise<string> {
    const page = await this.getPage();
    let selector = typeof refOrSelector === "number" 
      ? this.lastElementMap.get(refOrSelector) 
      : refOrSelector;

    if (!selector) {
      throw new Error(`Element ref [${refOrSelector}] not found. Run browser_snapshot first.`);
    }

    const locator = page.locator(selector).first();
    await locator.scrollIntoViewIfNeeded({ timeout: 4000 });
    await locator.fill(text, { timeout: 5000 });

    return `Filled "${text}" into element: "${selector}"`;
  }

  public async pressKey(key:string):Promise<string>{
    const page=await this.getPage();
    await page.keyboard.press(key);
    return `Pressed Key: ${key}`
  }

  public async takesScreenshot(outputPath?: string): Promise<string>{
    const page=await this.getPage();
    const dest=outputPath || path.resolve(process.cwd(), ".openclaw",`screenshot-${Date.now()}.png`);
    await page.screenshot({path:dest, fullPage: false});

    return `Screenshot saved to: ${dest}`;
  }

    /**
   * Closes the active browser or disconnects CDP session cleanly.
   */
  public async close(): Promise<string> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    this.activePage = null;
    return "Browser session closed.";
  }
}


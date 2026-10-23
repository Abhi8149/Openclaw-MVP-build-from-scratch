import { chromium } from "playwright";

async function main() {
  const endpoint = "http://127.0.0.1:9223";

  try {
    console.log("Connecting to Chrome...");

    const browser = await chromium.connectOverCDP(endpoint, {
      timeout: 10_000,
    });

    const contexts = browser.contexts();

    if (contexts.length === 0) {
      throw new Error("Connected, but no browser context was found.");
    }

    const context = contexts[0];
    const pages = context!.pages();

    console.log("CDP connection successful.");
    console.log("Context count:", contexts.length);
    console.log(
      "Open tabs:",
      pages.map((page) => ({
        url: page.url(),
      })),
    );

    const page = pages[0] ?? await context!.newPage();

    await page.goto("https://google.com", {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    console.log("Page title:", await page.title());
    console.log("Current URL:", page.url());

    await browser.close();
    console.log("Playwright disconnected.");
  } catch (error) {
    console.error("CDP test failed:", error);
    process.exitCode = 1;
  }
}

main();
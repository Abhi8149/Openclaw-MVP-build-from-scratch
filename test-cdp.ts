
import { chromium } from "playwright";

async function main() {
  const browser = await chromium.connectOverCDP(
    "http://127.0.0.1:9223"
  );

  const context = browser.contexts()[0];
  if (!context) throw new Error("No Chrome context found");

  // Create a completely new tab.
  const page = await context.newPage();

  page.on("framenavigated", frame => {
    if (frame === page.mainFrame()) {
      console.log("Main frame URL:", frame.url());
    }
  });

  page.on("requestfailed", request => {
    console.log(
      "Failed request:",
      request.url(),
      request.failure()?.errorText
    );
  });

  console.log("New tab URL:", page.url());

  try {
    await page.goto("https://google.com", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    console.log("SUCCESS:", page.url());
    console.log("Title:", await page.title());
  } catch (error) {
    console.error("Navigation error:", error);
    console.log("Final URL:", page.url());
  }

  // Intentionally do not close the browser while debugging.
}

main().catch(console.error);

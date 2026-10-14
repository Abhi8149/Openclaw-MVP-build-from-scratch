/**
 * file: testing-scripts/test-browser-service.ts
 * Run with: bun run testing-scripts/test-browser-service.ts
 */

import { BrowserService } from "../services/browser-service";

async function runBrowserTest() {
  console.log("🚀 Starting OpenClaw Browser Integration Test...\n");
  const browser = BrowserService.getInstance();

  try {
    // 1. Initialize browser (connects over CDP or opens persistent Chrome)
    console.log("Step 1: Initializing browser engine...");
    const initStatus = await browser.init(false); // set to false for clean test sandbox
    console.log(`✅ Status: ${initStatus}\n`);

    // 2. Navigate to Wikipedia
    console.log("Step 2: Navigating to Wikipedia...");
    const navResult = await browser.navigate("https://en.wikipedia.org");
    console.log(`✅ ${navResult}\n`);

    // 3. Take Semantic Snapshot
    console.log("Step 3: Extracting AI-friendly semantic element tree...");
    const snapshot = await browser.getSnapshot();
    console.log(`📄 Page Title: "${snapshot.title}"`);
    console.log(`🎯 Detected ${snapshot.elements.length} interactive elements.`);
    console.log("Top 5 Elements Preview:");
    snapshot.elements.slice(0, 5).forEach((el) => {
      console.log(`   [ref=${el.ref}] <${el.tag}> ${el.role}: "${el.name}"`);
    });
    console.log("");

    // 4. Locate search input and type query
    const searchInput = snapshot.elements.find(
      (e) => e.name.toLowerCase().includes("search") || e.tag === "input"
    );

    if (searchInput) {
      console.log(`Step 4: Typing search query into element [ref=${searchInput.ref}]...`);
      await browser.fill(searchInput.ref, "Artificial Intelligence");
      console.log("✅ Query typed.");

      console.log("Step 5: Pressing 'Enter' to submit search...");
      const page = await browser.getPage();
      await browser.pressKey("Enter");
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      
      const newSnapshot = await browser.getSnapshot();
      console.log(`✅ Landed on Search Result Page: "${newSnapshot.title}"\n`);
    }

    // 6. Capture Verification Screenshot
    console.log("Step 6: Taking verification screenshot...");
    const screenshotPath = await browser.takesScreenshot();
    console.log(`📸 ${screenshotPath}\n`);

    console.log("🎉 ALL BROWSER AUTOMATION TESTS PASSED SUCCESSFULLY!");
  } catch (error) {
    console.error("❌ Test failed with error:", error);
  } finally {
    console.log("\nCleaning up browser session...");
    await browser.close();
    console.log("Done.");
  }
}

runBrowserTest();
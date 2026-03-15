/**
 * Debug rename dialog interaction - test different select-all strategies
 */
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

async function main() {
  const strategy = process.argv[2] ?? "triple-click"; // triple-click | ctrl-a | js-select

  const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes("notebooklm")) ?? pages[0];
  const cdp = await page.createCDPSession();

  // Read current input value first
  const inputVal = await page.evaluate(() => {
    const input = document.querySelector('input[type="text"], mat-dialog-container input, .cdk-overlay-container input') as HTMLInputElement | null;
    return input ? { value: input.value, tag: input.tagName, id: input.id, className: input.className } : null;
  });
  console.log("Current input:", JSON.stringify(inputVal));

  if (!inputVal) {
    console.log("No dialog input found. Open rename dialog first.");
    browser.disconnect();
    return;
  }

  // Click input to focus
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 710, y: 437, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 710, y: 437, button: "left", clickCount: 1 });
  await new Promise(r => setTimeout(r, 200));

  if (strategy === "triple-click") {
    console.log("Strategy: triple-click to select all");
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 710, y: 437, button: "left", clickCount: 3 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 710, y: 437, button: "left", clickCount: 3 });
    await new Promise(r => setTimeout(r, 200));
  } else if (strategy === "ctrl-a") {
    console.log("Strategy: Ctrl+A via CDP");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 }); // 2 = Ctrl
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
    await new Promise(r => setTimeout(r, 200));
  } else if (strategy === "js-select") {
    console.log("Strategy: JS select() + focus");
    await page.evaluate(() => {
      const input = document.querySelector('input[type="text"], mat-dialog-container input, .cdk-overlay-container input') as HTMLInputElement | null;
      if (input) {
        input.focus();
        input.select();
      }
    });
    await new Promise(r => setTimeout(r, 200));
  }

  // Now paste replacement text
  await cdp.send("Input.insertText", { text: "Phase F 測試" });
  await new Promise(r => setTimeout(r, 300));

  // Read value after
  const afterVal = await page.evaluate(() => {
    const input = document.querySelector('input[type="text"], mat-dialog-container input, .cdk-overlay-container input') as HTMLInputElement | null;
    return input?.value ?? "NOT FOUND";
  });
  console.log("After:", afterVal);
  console.log("Success:", afterVal === "Phase F 測試");

  // Screenshot
  const result = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
  writeFileSync("spike/browser-capability/screenshots/rename-debug.png", Buffer.from(result.data, "base64"));
  console.log("Screenshot saved");

  browser.disconnect();
}

main();

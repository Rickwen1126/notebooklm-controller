/**
 * Debug: find clickable elements, test click on correct target
 */
import puppeteer from "puppeteer-core";

const CDP_URL = "http://127.0.0.1:9222";

async function main() {
  const browser = await puppeteer.connect({
    browserURL: CDP_URL,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes("notebooklm")) ?? pages[0]!;
  const cdp = await page.createCDPSession();

  // Find the "+ 新建" button bounding box
  const newBtnInfo = await page.evaluate(() => {
    // Search for buttons/links with "新建" text
    const allElements = document.querySelectorAll("button, a, [role=button]");
    const results: Array<{
      tag: string;
      text: string;
      rect: DOMRect;
      class: string;
    }> = [];
    for (const el of allElements) {
      const text = el.textContent?.trim() ?? "";
      if (text.includes("新建") || text.includes("New") || text.includes("add")) {
        results.push({
          tag: el.tagName,
          text: text.slice(0, 60),
          rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
          class: el.className?.toString().slice(0, 80),
        });
      }
    }
    return results;
  });
  console.log(
    "新建 buttons:",
    JSON.stringify(newBtnInfo, null, 2),
  );

  // Find Docker Deep Dive link
  const ddInfo = await page.evaluate(() => {
    const allLinks = document.querySelectorAll("a, tr[tabindex], [role=link]");
    const results: Array<{
      tag: string;
      text: string;
      rect: DOMRect;
      href?: string;
    }> = [];
    for (const el of allLinks) {
      const text = el.textContent?.trim() ?? "";
      if (text.includes("Docker")) {
        results.push({
          tag: el.tagName,
          text: text.slice(0, 60),
          rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
          href: (el as HTMLAnchorElement).href,
        });
      }
    }
    return results;
  });
  console.log("\nDocker links:", JSON.stringify(ddInfo, null, 2));

  browser.disconnect();
}

main();

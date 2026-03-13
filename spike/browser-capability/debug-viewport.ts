import puppeteer from "puppeteer-core";

const CDP_URL = "http://127.0.0.1:9222";

async function main() {
  const browser = await puppeteer.connect({
    browserURL: CDP_URL,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  const page = pages[0]!;
  const cdp = await page.createCDPSession();

  // Clear any stale emulation override
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  const viewport = await page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
  console.log("After clear override:", JSON.stringify(viewport));

  browser.disconnect();
}

main();

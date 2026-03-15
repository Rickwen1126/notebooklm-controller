/**
 * Test: does puppeteer.connect() override viewport?
 */
import puppeteer from "puppeteer-core";
import { WebSocket } from "ws";

const CDP_URL = "http://127.0.0.1:9222";

async function checkRaw(label: string) {
  const res = await fetch(`${CDP_URL}/json`);
  const targets = (await res.json()) as Array<{
    webSocketDebuggerUrl: string;
    type: string;
    url: string;
  }>;
  const t = targets.find(
    (t) => t.type === "page" && t.url.includes("notebooklm"),
  );
  if (!t) return console.log(`${label}: no target`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 1;
  function send(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      ws.on("message", function handler(data: Buffer) {
        const msg = JSON.parse(data.toString());
        if (msg.id === msgId) {
          ws.off("message", handler);
          msg.error ? reject(msg.error) : resolve(msg.result);
        }
      });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }
  await new Promise((r) => ws.on("open", r));
  const r = (await send("Runtime.evaluate", {
    expression: `JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})`,
    returnByValue: true,
  })) as { result: { value: string } };
  console.log(`${label}: ${r.result.value}`);
  ws.close();
}

async function main() {
  await checkRaw("Before puppeteer");

  // Connect puppeteer with defaultViewport: null
  const browser = await puppeteer.connect({
    browserURL: CDP_URL,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  console.log(`puppeteer connected, ${pages.length} pages`);

  await checkRaw("After puppeteer.connect + pages()");

  browser.disconnect();
}

main();

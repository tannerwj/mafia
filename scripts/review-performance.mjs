// Five cold loads with a repeatable 360px, 4x CPU, slow-cellular profile.
// This targets the isolated local Worker only; results are not production CWV.
import { chromium } from "@playwright/test";

const base = process.env.MAFIA_REVIEW_BASE_URL ?? "http://localhost:5319";
const url = new URL(base);
if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("Loopback only");

const browser = await chromium.launch();
const samples = [];
try {
  for (let i = 0; i < 5; i++) {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 93_750 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.addInitScript(() => {
      window.__reviewLcp = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__reviewLcp = entry.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    });
    await page.goto(base, { waitUntil: "networkidle" });
    const timing = await page.evaluate(() => ({
      dcl: performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? null,
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
      lcp: window.__reviewLcp ?? null,
    }));
    const createAt = performance.now();
    await page.getByTestId("create-room").click();
    await page.waitForURL(/\/room\/[A-Z0-9]{5}$/);
    timing.createToRoute = performance.now() - createAt;
    samples.push(timing);
    await context.close();
  }
} finally {
  await browser.close();
}

const stats = (key) => {
  const sorted = samples.map((sample) => Math.round(sample[key])).sort((a, b) => a - b);
  return { n: sorted.length, p50Ms: sorted[2], p95Ms: sorted[4], valuesMs: sorted };
};
console.log(JSON.stringify({ profile: "local workerd; 360x800; 4x CPU; 150ms RTT; 1.6Mbps down; cache disabled", dcl: stats("dcl"), fcp: stats("fcp"), lcp: stats("lcp"), createToRoute: stats("createToRoute") }, null, 2));

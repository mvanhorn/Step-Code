import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:3277/#token=XUGYgMlQNfvKK8DpOlXSzVjipt-whVAV");
await page.waitForSelector("#prompt", { timeout: 15000 });
await page.waitForTimeout(2500);
const dom = await page.evaluate(() => {
  const badge = document.querySelector(".stream-inner .message-skill");
  const art = badge?.closest("article");
  const body = badge?.closest(".message-body");
  return {
    badgeText: badge?.textContent ?? null,
    articleClass: art?.className ?? null,
    articleIsUser: art?.classList.contains("user") ?? false,
    bodyBg: body ? getComputedStyle(body).backgroundColor : null,
    badgeInBody: Boolean(badge && body?.contains(badge)),
    bodyChildren: body ? [...body.childNodes].map((n) => n.nodeName + "|" + (n.textContent?.slice(0, 18) ?? "")) : null,
    bodyText: body?.textContent?.slice(0, 60) ?? null,
  };
});
console.log(JSON.stringify(dom, null, 1));
await page.screenshot({ path: "/tmp/badge-check.png" });
await browser.close();

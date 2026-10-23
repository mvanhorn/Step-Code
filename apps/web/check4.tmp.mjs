import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:3277/#token=yEmf3RM2hmdSCTVnn6ZLf_i6TM7_yTdK");
await page.waitForSelector("#prompt", { timeout: 15000 });
await page.waitForTimeout(3000);
const dom = await page.evaluate(() => {
  const badges = [...document.querySelectorAll(".stream-inner .message-skill")];
  return badges.map((badge) => {
    const art = badge.closest("article");
    const body = badge.closest(".message-body");
    return {
      badge: badge.textContent?.slice(0, 20),
      artClass: art?.className.slice(0, 40),
      badgeParentIsBody: badge.parentElement === body,
      bodyBg: body ? getComputedStyle(body).backgroundColor : null,
      bodyText: body?.textContent?.slice(0, 40),
      artText: art?.textContent?.slice(0, 40),
    };
  });
});
console.log(JSON.stringify(dom, null, 1));
await browser.close();

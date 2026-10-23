import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:3277/#token=yEmf3RM2hmdSCTVnn6ZLf_i6TM7_yTdK");
await page.waitForSelector("#prompt", { timeout: 15000 });
await page.waitForTimeout(3000);
const titles = await page.evaluate(() =>
  [...document.querySelectorAll('[aria-label="会话列表"] button')].map((b) => b.textContent?.trim().slice(0, 24)).filter(Boolean),
);
console.log("titles:", JSON.stringify(titles));
const target = page.locator('[aria-label="会话列表"] button', { hasText: "你好" }).first();
if (await target.count()) { await target.click(); await page.waitForTimeout(2000); }
const dom = await page.evaluate(() => {
  const arts = [...document.querySelectorAll(".stream-inner article.message")];
  const goalArt = arts.find((a) => a.textContent?.includes("整理一下这个项目的文件"));
  const badge = goalArt?.querySelector(".message-skill");
  const body = goalArt?.querySelector(":scope > .message-body");
  return {
    artCount: arts.length,
    goalArtClass: goalArt?.className ?? null,
    badgeInThisArt: Boolean(badge),
    badgeInBody: Boolean(badge && body?.contains(badge)),
    bodyHasBubble: body ? getComputedStyle(body).backgroundColor : null,
    bodyText: body?.textContent?.slice(0, 50) ?? null,
    artHTML: goalArt?.outerHTML.slice(0, 300) ?? null,
  };
});
console.log(JSON.stringify(dom, null, 1));
await page.screenshot({ path: "/tmp/seeded-check.png" });
await browser.close();

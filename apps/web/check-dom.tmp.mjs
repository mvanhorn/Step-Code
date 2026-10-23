import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:3277/#token=XUGYgMlQNfvKK8DpOlXSzVjipt-whVAV");
await page.waitForSelector("#prompt", { timeout: 15000 });
await page.waitForTimeout(2000);
const clicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find(b => b.textContent?.includes("整理一下这个项目的文件"));
  if (btn) { btn.click(); return btn.textContent.slice(0, 30); }
  return null;
});
await page.waitForTimeout(2000);
const dom = await page.evaluate(() => {
  const badge = document.querySelector(".stream-inner .message-skill");
  const art = badge?.closest("article");
  const body = badge?.closest(".message-body");
  return {
    badgeText: badge?.textContent ?? null,
    articleClass: art?.className ?? null,
    articleIsUser: art?.classList.contains("user") ?? false,
    bodyBg: body ? getComputedStyle(body).backgroundColor : null,
    bodyIsBubble: body ? getComputedStyle(body).borderRadius : null,
    badgeHTML: badge?.outerHTML?.slice(0, 150) ?? null,
    siblings: body ? [...body.childNodes].map(n => n.nodeName + ":" + (n.textContent?.slice(0,20) ?? "")) : null,
  };
});
  const body = document.querySelector(".stream-inner .message.user .message-body");
  const badge = document.querySelector(".stream-inner .message.user .message-skill");
  const bubble = document.querySelector(".stream-inner .message.user");
  return {
    clicked: null,
    bubbleExists: Boolean(bubble),
    badgeInsideBubble: Boolean(badge && bubble?.contains(badge)),
    badgeInsideBody: Boolean(badge && body?.contains(badge)),
    badgeParentClass: badge?.parentElement?.className ?? null,
    bodyHTML: body?.innerHTML?.slice(0, 200) ?? null,
    bubbleHTML: bubble?.outerHTML?.slice(0, 260) ?? null,
  };
});
console.log(JSON.stringify({ clicked, dom }, null, 1));
await page.screenshot({ path: "/tmp/echo-bubble-check.png" });
await browser.close();

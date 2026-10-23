import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
await page.goto("http://127.0.0.1:3277/#token=yEmf3RM2hmdSCTVnn6ZLf_i6TM7_yTdK");
await page.waitForSelector("#prompt", { timeout: 15000 });
await page.waitForTimeout(3500);
const api = await page.evaluate(async () => {
  const list = await fetch("/api/v1/sessions").then((r) => r.json()).catch(() => null);
  const sessions = list?.sessions ?? list ?? [];
  return sessions.slice(0, 8).map((s) => ({ id: s.id?.slice(0, 8), first: s.firstMessage?.slice(0, 16) }));
});
console.log("API sessions:", JSON.stringify(api));
const seeded = api.find((s) => s.first === "你好");
if (seeded) {
  const clicked = await page.evaluate((id) => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("你好"));
    if (btn) { btn.click(); return true; }
    return false;
  }, seeded.id);
  await page.waitForTimeout(2500);
  const dom = await page.evaluate(() => {
    const arts = [...document.querySelectorAll(".stream-inner article.message")];
    const goal = arts.find((a) => a.textContent?.includes("整理一下这个项目的文件"));
    const body = goal?.querySelector(":scope > .message-body");
    const badge = goal?.querySelector(".message-skill");
    return {
      clicked: true, arts: arts.length,
      goalClass: goal?.className ?? null,
      badgeInBody: Boolean(badge && body?.contains(badge)),
      bodyHTML: body?.innerHTML.slice(0, 220) ?? null,
    };
  });
  console.log(JSON.stringify(dom, null, 1));
  await page.screenshot({ path: "/tmp/seeded-final.png" });
} else {
  console.log("seeded session not in API list");
}
await browser.close();

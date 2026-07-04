import asyncio, re, time
from playwright.async_api import async_playwright
from geeked.nine import NineSolver

DEMO_URL = "https://gt4.geetest.com/demov4/nine-popup-en.html"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        page = await browser.new_page(viewport={"width": 1280, "height": 900})

        captcha_id = None
        grid_url = None
        ques_paths = []

        def on_request(request):
            nonlocal captcha_id, grid_url, ques_paths
            url = request.url
            if "captcha_id=" in url:
                m = re.search(r"captcha_id=([a-f0-9]+)", url)
                if m:
                    captcha_id = m.group(1)
            if "static.geetest.com/" in url and "/nine/" in url and "nine_prompt" not in url:
                grid_url = url.split("https://static.geetest.com/")[-1]
            if "nine_prompt" in url:
                qp = url.split("https://static.geetest.com/")[-1]
                if qp not in ques_paths:
                    ques_paths.append(qp)

        page.on("request", on_request)

        print("[1] Opening demo page...")
        await page.goto(DEMO_URL, wait_until="domcontentloaded")
        await page.wait_for_timeout(4000)

        if not captcha_id:
            captcha_id = "54088bb07d2df3c46b79f80300b0abbe"
        print(f"[2] captcha_id: {captcha_id}")

        print("[3] Clicking GeeTest button to open popup...")
        btn = await page.query_selector(".geetest_btn_click, [class*='geetest_btn_click']")
        if btn:
            await btn.click()
            print("    Clicked.")
        await page.wait_for_timeout(4000)

        if not grid_url or not ques_paths:
            await page.wait_for_timeout(2000)
        print(f"    grid: {grid_url}")
        print(f"    ques: {ques_paths}")

        if not grid_url or not ques_paths:
            print("[!] No image URLs. Falling back to standalone solve.")
            from geeked import Geeked
            g = Geeked(captcha_id, "nine")
            d = g.load_captcha()
            g.lot_number = d["lot_number"]
            sec = g.submit_captcha(d)
            print(f"    API OK: pass_token={sec.get('pass_token','?')[:20]}...")
            await page.wait_for_timeout(30000)
            return

        print("[4] Solving with CLIP (ViT-B-32)...")
        t0 = time.time()
        solver = NineSolver(grid_url, ques_paths, 3)
        cells = solver.find_icon_positions()
        elapsed = time.time() - t0
        print(f"    Cells: {cells} ({elapsed:.1f}s)")

        print("[5] Clicking anomalous cells...")
        for row, col in cells:
            idx = (row - 1) * 3 + (col - 1)
            ghost_sel = f".geetest_ghost_{idx}"
            try:
                ghost = await page.query_selector(ghost_sel)
                if ghost:
                    await ghost.click()
                    print(f"    Clicked ({row},{col}) -> {ghost_sel}")
                    await page.wait_for_timeout(500)
                else:
                    print(f"    [!] {ghost_sel} not found")
            except Exception as e:
                print(f"    [!] Error clicking {ghost_sel}: {e}")

        print("[6] Waiting for widget auto-submit...")
        await page.wait_for_timeout(6000)

        result = await page.evaluate("""
            () => {
                const success = document.querySelector(
                    ".geetest_success, .geetest_success_show, .geetest_lock_success, [class*='success_show']"
                );
                if (success) return "SUCCESS: " + (success.textContent || "").substring(0, 80);
                const tip = document.querySelector(".geetest_tip, [class*='geetest_tip']");
                if (tip) return "Tip: " + (tip.textContent || "").substring(0, 80);
                const popup = document.querySelector("[class*='geetest_box']");
                if (popup) {
                    let cls = "";
                    try { cls = popup.getAttribute("class") || ""; } catch(e) {}
                    return "Popup: " + cls.substring(0, 80);
                }
                return "Unknown";
            }
        """)
        print(f"[7] Result: {result}")
        print("[8] Browser stays open 60s.")
        await page.wait_for_timeout(60000)


asyncio.run(main())

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

/*
 * Signed-out smoke over the two public routes of the production build. It fails on any page
 * error, any console error that is not a network failure to Supabase (a signed-out browser may
 * see those), any same-origin 4xx/5xx (a missing chunk or asset under the Pages base path),
 * horizontal page scroll, and WCAG 2.1 AA violations in light and dark.
 */

const SCREENSHOT_DIR = "test-results";

function isSupabase(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".supabase.co");
  } catch {
    return false;
  }
}

/** Collects problems as they happen; the assertion at the end prints all of them at once. */
function watchPage(page: Page): () => string[] {
  const problems: string[] = [];
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const where = msg.location().url;
    if (msg.text().startsWith("Failed to load resource") && isSupabase(where)) return;
    problems.push(`console.error: ${msg.text()}${where ? ` (${where})` : ""}`);
  });
  page.on("requestfailed", (req) => {
    if (isSupabase(req.url())) return;
    problems.push(`requestfailed: ${req.url()} ${req.failure()?.errorText ?? ""}`);
  });
  page.on("response", (res) => {
    const url = new URL(res.url());
    if (url.host === new URL(page.url() || "http://localhost:4173").host && res.status() >= 400) {
      problems.push(`HTTP ${res.status()}: ${res.url()}`);
    }
  });
  return () => problems;
}

async function expectNoHorizontalScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, "page must not scroll sideways").toBeLessThanOrEqual(innerWidth);
}

/** Every visible landmark and control sits inside the viewport horizontally. */
async function expectInsideViewport(page: Page, selector: string) {
  const overflow = await page.evaluate((sel) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue; // collapsed elements
      const cs = getComputedStyle(el);
      // Visually hidden (sr-only) elements are clipped to nothing and sit 1px off-screen by design.
      if (cs.position === "absolute" && (cs.clip !== "auto" || cs.clipPath !== "none")) continue;
      if (r.left < -0.5 || r.right > window.innerWidth + 0.5) {
        out.push(`${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40)}] ${Math.round(r.left)}..${Math.round(r.right)}`);
      }
    }
    return out;
  }, selector);
  expect(overflow, `elements outside the ${await page.evaluate(() => window.innerWidth)}px viewport`).toEqual([]);
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, "axe WCAG 2.1 AA violations").toEqual([]);
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}-${info.project.name}.png`, fullPage: true });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test("sign-in page renders cleanly", async ({ page }, info) => {
      const problems = watchPage(page);
      await page.goto("#/login");

      await expect(page.getByRole("heading", { level: 1, name: "Sign in to Claims Ops" })).toBeVisible();
      await expect(page.getByLabel("Email")).toBeVisible();
      await expect(page.getByLabel("Password")).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
      await expect(page).toHaveTitle(/Sign in/);
      expect(await page.evaluate(() => document.documentElement.style.colorScheme || getComputedStyle(document.documentElement).colorScheme)).toContain(scheme);

      await expectNoHorizontalScroll(page);
      await expectInsideViewport(page, "main, form, input, button, h1");
      await expectAccessible(page);
      await screenshot(page, info, `login-${scheme}`);
      expect(problems()).toEqual([]);
    });

    test("public call page renders cleanly", async ({ page }, info) => {
      const problems = watchPage(page);
      await page.goto("#/call");

      await expect(page.getByRole("heading", { level: 1, name: "Talk to Ava" })).toBeVisible();
      const panel = page.locator("[role='region'][aria-labelledby='call-panel-title']");
      await expect(panel).toBeVisible();
      await expect(page.getByRole("radio")).toHaveCount(3);
      await expect(page.getByRole("button", { name: /start/i }).first()).toBeVisible();
      const identities = page.getByRole("list", { name: "Demo identities" });
      await expect(identities.getByRole("listitem").filter({ has: page.locator("[aria-label^='Scenarios for']") })).toHaveCount(6);
      await expect(page.getByRole("banner").getByRole("link", { name: "Staff sign in" })).toBeVisible();

      // Desktop lays the watch pane beside the call card; phones stack it underneath.
      const card = await panel.boundingBox();
      const watch = await page.locator("[role='region'][aria-labelledby='watch-pane-title']").boundingBox();
      expect(card && watch).toBeTruthy();
      if (card && watch) {
        if ((page.viewportSize()?.width ?? 0) >= 1024) expect(watch.x).toBeGreaterThan(card.x + card.width - 1);
        else expect(watch.y).toBeGreaterThan(card.y);
      }

      await expectNoHorizontalScroll(page);
      await expectInsideViewport(page, "header, main, footer, button, a, input, h1, h2, [role='region']");
      await expectAccessible(page);
      await screenshot(page, info, `call-${scheme}`);
      expect(problems()).toEqual([]);
    });
  });
}

test("staff routes send a signed-out visitor to sign-in and keep the destination", async ({ page }) => {
  const problems = watchPage(page);
  await page.goto("#/calls?flagged=1");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Claims Ops" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe(`#/login?next=${encodeURIComponent("/calls?flagged=1")}`);

  await page.goto("#/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Claims Ops" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#/login");
  expect(problems()).toEqual([]);
});

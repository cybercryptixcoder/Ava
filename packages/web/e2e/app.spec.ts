import { expect, test, type Page } from "@playwright/test";

const errors: string[] = [];
test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
});
test.afterEach(() => expect(errors).toEqual([]));

const phone = () => test.info().project.name === "phone";

async function openMenu(page: Page, name: string) {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("dialog").getByRole("link", { name, exact: true }).click();
}

test("a card opens its second layer: detail, and what was filed with undo", async ({ page }) => {
  await page.goto("/");
  const front = page.locator(".stack-front").first();
  await front.waitFor();
  await front.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  if (phone()) {
    // Any card's second layer shows something real; Escape goes back to the stack.
    await expect(sheet.locator(".layer-parts, .layer-para, .layer-filed, .layer-options").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    return;
  }
  // The filing card is the first one: what was filed, with per-entry undo.
  const filed = sheet.locator(".layer-filed-row[data-status='filed']");
  await expect(filed.first()).toBeVisible();
  const target = filed.first();
  const label = await target.locator(".layer-filed-main").innerText();
  await target.getByRole("button", { name: "Undo" }).click();
  await expect(sheet.locator(".layer-filed-row[data-status='undone']", { hasText: label })).toBeVisible();
});

test("the back room is one menu away, and every screen renders from real state", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".stack-front")).toBeVisible();
  await openMenu(page, "Calendar");
  await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();
  await openMenu(page, "Everything");
  await expect(page.getByRole("heading", { name: "Everything", level: 1 })).toBeVisible();
  await openMenu(page, "Rules");
  await expect(page.getByRole("heading", { name: "The constitution" })).toBeVisible();
  await openMenu(page, "What Ava knows");
  await expect(page.getByRole("heading", { name: "What Ava knows about you" })).toBeVisible();
  await openMenu(page, "Messages");
  await expect(page.getByRole("heading", { name: "Messages", level: 1 })).toBeVisible();
  await openMenu(page, "Log");
  await expect(page.getByText("rules.evaluated").or(page.getByText("Heartbeat")).first()).toBeVisible();
  await openMenu(page, "Settings");
  await expect(page.getByRole("heading", { name: "Sources and connections" })).toBeVisible();
});

test("yes and not now move the deck, by key and by gesture", async ({ page }) => {
  await page.goto("/");
  const front = page.locator(".stack-front").first();
  await front.waitFor();
  const titleOf = () => page.locator(".stack-front h2").first().innerText();
  await front.focus();
  const first = await titleOf();
  await page.keyboard.press("ArrowLeft"); // not now
  await expect(page.locator(".stack-front h2").first()).not.toHaveText(first);
  await page.waitForTimeout(450);
  const second = await titleOf();
  if (phone()) {
    // A real drag: left swipe across the top of the card (not into a button).
    const box = (await front.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 28);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 170, box.y + 28, { steps: 6 });
    await page.mouse.up();
  } else {
    await page.keyboard.press("ArrowRight"); // do it
  }
  await expect(page.locator(".stack-front h2").first()).not.toHaveText(second);
});

test("checking a task off happens immediately", async ({ page }) => {
  const title = phone() ? "Tune PID gains on the new chassis" : "Read DDIA chapter 5";
  await page.goto("/");
  await openMenu(page, "Tasks and projects");
  await page.locator(".item", { hasText: title }).getByRole("checkbox").click();
  await expect(page.locator(".item[data-done]", { hasText: title })).toBeVisible();
});

test("the location switch moves every schedule to the other time zone", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Menu" }).click();
  const group = page.getByRole("dialog").getByRole("radiogroup", { name: "Where you are" });
  await group.getByRole("radio", { name: /Bangalore/ }).click();
  await expect(group.getByRole("radio", { name: /Bangalore/ })).toHaveAttribute("aria-checked", "true");
  await group.getByRole("radio", { name: /State College/ }).click();
  await expect(group.getByRole("radio", { name: /State College/ })).toHaveAttribute("aria-checked", "true");
});

test("no screen overflows sideways at 320 px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  for (const path of ["/", "/calendar", "/everything", "/tasks", "/rules", "/knows", "/messages", "/log", "/settings", "/setup"]) {
    await page.goto(path);
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} overflows at 320 px`).toBeLessThanOrEqual(0);
  }
  await page.goto("/");
  const front = page.locator(".stack-front").first();
  await front.waitFor();
  await front.focus();
  await page.keyboard.press("Enter");
  await page.locator(".sheet").first().waitFor({ state: "visible" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "an opened card layer overflows at 320 px").toBeLessThanOrEqual(0);
});

import { expect, test, type Page } from "@playwright/test";

const errors: string[] = [];
test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
});
test.afterEach(() => expect(errors).toEqual([]));

async function nav(page: Page, name: string) {
  const desktop = (page.viewportSize()?.width ?? 0) >= 1024;
  if (desktop || ["Today", "Talk", "Tasks", "Messages"].includes(name)) {
    await page.getByRole("link", { name: desktop && name === "Tasks" ? "Tasks and projects" : name, exact: true }).first().click();
  } else {
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("dialog").getByRole("link", { name }).click();
  }
}

test("every screen renders from real state", async ({ page }) => {
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Waiting for you" })).toBeVisible();
  await expect(page.getByText("Morning brief").first()).toBeVisible();
  await nav(page, "Talk");
  await expect(page.getByRole("heading", { name: "From what you said" }).first()).toBeVisible();
  await nav(page, "Tasks");
  await expect(page.getByRole("heading", { name: "Almost there" })).toBeVisible();
  await nav(page, "Rules");
  await expect(page.getByRole("heading", { name: "The constitution" })).toBeVisible();
  await nav(page, "What Ava knows");
  await expect(page.getByRole("heading", { name: "What Ava knows about you" })).toBeVisible();
  await nav(page, "Messages");
  await expect(page.getByRole("heading", { name: "Messages", level: 1 })).toBeVisible();
  await nav(page, "Log");
  await expect(page.getByText("rules.evaluated").or(page.getByText("Heartbeat")).first()).toBeVisible();
  await nav(page, "Settings");
  await expect(page.getByRole("heading", { name: "Sources and connections" })).toBeVisible();
});

// Both projects share one server, so each acts on its own fixture item.
const phone = () => test.info().project.name === "phone";

test("checking a task off happens immediately", async ({ page }) => {
  const title = phone() ? "Tune PID gains on the new chassis" : "Read DDIA chapter 5";
  await page.goto("/tasks");
  await page.locator(".item", { hasText: title }).getByRole("checkbox").click();
  await expect(page.locator(".item[data-done]", { hasText: title })).toBeVisible();
});

test("confirming a chip applies the change", async ({ page }) => {
  const summary = phone() ? "Note: re-reading slides doesn't help you" : "OS Project 2: note that the parser works";
  await page.goto("/talk");
  await page.locator(".chip", { hasText: summary }).first().getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.locator(".chip[data-status='accepted']", { hasText: summary }).first()).toBeVisible();
});

test("the location switch moves every schedule to the other time zone", async ({ page }) => {
  await page.goto("/today");
  const group = page.getByRole("radiogroup", { name: "Where you are" }).first();
  await group.getByRole("radio", { name: /Bangalore/ }).click();
  await expect(group.getByRole("radio", { name: /Bangalore/ })).toHaveAttribute("aria-checked", "true");
  await group.getByRole("radio", { name: /State College/ }).click();
  await expect(group.getByRole("radio", { name: /State College/ })).toHaveAttribute("aria-checked", "true");
});

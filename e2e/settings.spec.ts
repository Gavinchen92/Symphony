import { expect, test } from "@playwright/test";

test("设置页可以保存系统错误自监控配置", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("heading", { name: "全局设置" })).toBeVisible();

  const monitorToggle = page.getByLabel("启用系统错误自监控");
  const cooldownInput = page.getByLabel("重复错误冷却时间（分钟）");

  await expect(monitorToggle).toBeChecked();
  await expect(cooldownInput).toHaveValue("30");

  await monitorToggle.uncheck();
  await cooldownInput.fill("45");
  await page.getByRole("button", { name: "保存" }).click();

  await page.reload();
  await page.getByRole("button", { name: "设置" }).click();

  await expect(page.getByLabel("启用系统错误自监控")).not.toBeChecked();
  await expect(page.getByLabel("重复错误冷却时间（分钟）")).toHaveValue("45");
});

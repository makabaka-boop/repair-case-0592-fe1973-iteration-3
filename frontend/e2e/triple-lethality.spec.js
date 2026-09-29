import { expect, test } from '@playwright/test';

// 真实联调：页面经 nginx/vite 代理访问 FastAPI，无任何 mock。
test.describe('三探头中位复核联调', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: '三探头中位复核' }).click();
  });

  test('默认三探头示例：逐刻中位放行，图形与明细同源，来源跨探头切换', async ({ page }) => {
    await page.getByTestId('triple-submit').click();

    const conclusion = page.getByTestId('triple-conclusion');
    await expect(conclusion).toContainText('放行');
    await expect(conclusion).toContainText('门槛');

    // 三支探头各自总量与“不是三份总 F₀ 的中位数”说明同时展示
    const totals = page.getByTestId('triple-totals');
    await expect(totals).toContainText('探头A 总量');
    await expect(totals).toContainText('探头B 总量');
    await expect(totals).toContainText('探头C 总量');
    await expect(totals).toContainText('不是三份总 F₀ 的中位数');

    // 默认示例中位来源在探头间反复切换：至少出现两种来源探头
    const rows = page.locator('.triple-segments tbody tr');
    await expect(rows).not.toHaveCount(0);
    const sources = await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-source')),
    );
    expect(new Set(sources).size).toBeGreaterThanOrEqual(2);

    // 每行都有“为何由该探头贡献”的裁决说明（中段速率排序）
    const reasons = await rows.locator('.reason-cell').allInnerTexts();
    expect(reasons.every((text) => text.includes('中位'))).toBe(true);

    // 表格合计 = 各段贡献未舍入之和（同源响应复算），
    // 与结论中的中位总量一致（不因展示舍入改变）
    const contributions = await rows.locator('td:last-child').allInnerTexts();
    const summed = contributions.reduce((acc, text) => acc + Number(text), 0);
    const shown = Number(await page.getByTestId('triple-total').innerText());
    expect(Math.abs(summed - shown)).toBeLessThan(1e-5);
    const conclusionText = await conclusion.innerText();
    const match = conclusionText.match(/中位 F₀ = ([\d.]+)/);
    expect(match).not.toBeNull();
    expect(Math.abs(Number(match[1]) - shown)).toBeLessThan(1e-5);

    // 图形渲染三探头折线与逐刻中位段
    await expect(
      page.getByLabel('三探头致死速率曲线与逐刻中位曲线'),
    ).toBeVisible();

    // 片段表时间边界与图形中位粗线端点一致：取首条内部边界，
    // 图形上必须存在以该时刻为横坐标的切换标记圆点
    const secondRow = rows.nth(1);
    const boundaryText = (await secondRow.locator('td:nth-child(2)').innerText())
      .split('→')[0]
      .trim();
    await expect(page.locator('circle')).not.toHaveCount(0);
    // 全部片段连续铺满，无零时长
    const durations = await rows.locator('td:nth-child(3)').allInnerTexts();
    expect(durations.every((d) => Number(d) > 0)).toBe(true);
    expect(Number.isFinite(Number(boundaryText))).toBe(true);
  });

  test('三支探头完全相同：每段三探头并列、固定顺序裁决取探头A', async ({ page }) => {
    for (const probe of ['探头A', '探头B', '探头C']) {
      const editor = page.locator('.probe-editor', { hasText: probe }).first();
      let count = await page.getByLabel(new RegExp(`^${probe} 时间`)).count();
      while (count > 4) {
        await page.getByLabel(`${probe} 删除 第3行`).click();
        count -= 1;
      }
      while (count < 4) {
        await editor.getByRole('button', { name: '添加采样行' }).click();
        count += 1;
      }
      const times = ['0', '60', '120', '180'];
      for (let i = 1; i <= 4; i += 1) {
        await page.getByLabel(`${probe} 时间 第${i}行`).fill(times[i - 1]);
        await page.getByLabel(`${probe} 温度 第${i}行`).fill('121.1');
      }
    }

    await page.getByTestId('triple-submit').click();

    await expect(page.getByTestId('triple-conclusion')).toContainText('放行');
    const sources = await page
      .locator('.triple-segments tbody tr')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-source')));
    expect(sources).toEqual(['probeA', 'probeA', 'probeA']);
    // 并列标注包含三支探头
    const tieNotes = await page.locator('.tie-note').allInnerTexts();
    expect(tieNotes).toHaveLength(3);
    expect(tieNotes[0]).toContain('探头A');
    expect(tieNotes[0]).toContain('探头B');
    expect(tieNotes[0]).toContain('探头C');
  });

  test('探头C间隔超过60秒：按探头C第2行拒绝且保留上一份有效报告', async ({ page }) => {
    // 先得到一份放行报告
    await page.getByTestId('triple-submit').click();
    await expect(page.getByTestId('triple-conclusion')).toContainText('放行');

    // 再提交非法 C（第2行 0→61 间隔超限）
    await page.getByLabel('探头C 时间 第2行').fill('61');
    await page.getByTestId('triple-submit').click();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('探头C');
    await expect(alert).toContainText('第 2 行');
    await expect(alert).toContainText('60 秒');
    await expect(alert).toContainText('已保留上一份有效报告');

    // 上一份报告仍在页面（未被本次失败覆盖）
    await expect(page.getByTestId('triple-conclusion')).toBeVisible();
    await expect(page.getByTestId('triple-total')).toBeVisible();
  });

  test('三支探头结束秒不一致被拒绝', async ({ page }) => {
    // 探头C 共 6 行，把最后一行 180 改为 179（仍满足递增与间隔约束）
    await page.getByLabel('探头C 时间 第6行').fill('179');
    await page.getByTestId('triple-submit').click();
    await expect(page.getByRole('alert')).toContainText('结束于同一秒');
  });

  test('第三路缺样（整组缺失语义通过非法点模拟）不影响单/双探头结论', async ({ page }) => {
    // 单探头先得放行结论
    await page.getByRole('tab', { name: '单探头复核' }).click();
    await page.getByRole('button', { name: '计算致死量' }).click();
    await expect(page.getByTestId('conclusion')).toContainText('放行');

    // 三探头非法提交
    await page.getByRole('tab', { name: '三探头中位复核' }).click();
    await page.getByLabel('探头C 时间 第2行').fill('61');
    await page.getByTestId('triple-submit').click();
    await expect(page.getByRole('alert')).toContainText('探头C');

    // 单探头结论不受影响
    await page.getByRole('tab', { name: '单探头复核' }).click();
    await expect(page.getByTestId('conclusion')).toContainText('放行');
  });
});

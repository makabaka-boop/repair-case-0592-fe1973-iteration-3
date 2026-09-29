import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App.jsx';

// 手算交点样例：A 恒 2；B 1→4；C 4→1（[0,60]）。
// 交点 t=20/30/40，中位来源序列 probeA、probeB、probeC、probeA，
// 中位总量 25/12 ≈ 2.0833（不放行）。
const tripleCrossingResponse = {
  threshold: 3.0,
  probeA: {
    probe: 'probeA',
    points: [
      { time: 0, temperature: 124.1, rate: 2 },
      { time: 60, temperature: 124.1, rate: 2 },
    ],
    totalUnrounded: 2.0,
    f0: 2.0,
  },
  probeB: {
    probe: 'probeB',
    points: [
      { time: 0, temperature: 121.1, rate: 1 },
      { time: 60, temperature: 127.1, rate: 4 },
    ],
    totalUnrounded: 2.5,
    f0: 2.5,
  },
  probeC: {
    probe: 'probeC',
    points: [
      { time: 0, temperature: 127.1, rate: 4 },
      { time: 60, temperature: 121.1, rate: 1 },
    ],
    totalUnrounded: 2.5,
    f0: 2.5,
  },
  probeATotalUnrounded: 2.0,
  probeBTotalUnrounded: 2.5,
  probeCTotalUnrounded: 2.5,
  probeAF0: 2.0,
  probeBF0: 2.5,
  probeCF0: 2.5,
  medianUnrounded: 25 / 12,
  medianF0: 2.08,
  passed: false,
  shortfall: 3 - 25 / 12,
  segments: [
    {
      index: 1,
      startTime: 0,
      endTime: 20,
      durationSeconds: 20,
      source: 'probeA',
      tie: ['probeA'],
      startOrder: ['probeB', 'probeA', 'probeC'],
      endOrder: ['probeA', 'probeB', 'probeC'],
      reason: '中段速率由低到高：探头B < 探头A < 探头C；中位曲线为探头A',
      startRate: 2,
      endRate: 2,
      probeAStartRate: 2,
      probeAEndRate: 2,
      probeBStartRate: 1,
      probeBEndRate: 2,
      probeCStartRate: 4,
      probeCEndRate: 3.5,
      contribution: 2 / 3,
    },
    {
      index: 2,
      startTime: 20,
      endTime: 30,
      durationSeconds: 10,
      source: 'probeB',
      tie: ['probeB'],
      startOrder: ['probeA', 'probeB', 'probeC'],
      endOrder: ['probeA', 'probeB', 'probeC'],
      reason: '中段速率由低到高：探头A < 探头B < 探头C；中位曲线为探头B',
      startRate: 2,
      endRate: 2.5,
      probeAStartRate: 2,
      probeAEndRate: 2,
      probeBStartRate: 2,
      probeBEndRate: 2.5,
      probeCStartRate: 3.5,
      probeCEndRate: 3,
      contribution: 0.375,
    },
    {
      index: 3,
      startTime: 30,
      endTime: 40,
      durationSeconds: 10,
      source: 'probeC',
      tie: ['probeC'],
      startOrder: ['probeA', 'probeC', 'probeB'],
      endOrder: ['probeA', 'probeC', 'probeB'],
      reason: '中段速率由低到高：探头A < 探头C < 探头B；中位曲线为探头C',
      startRate: 2.5,
      endRate: 2,
      probeAStartRate: 2,
      probeAEndRate: 2,
      probeBStartRate: 2.5,
      probeBEndRate: 3,
      probeCStartRate: 2.5,
      probeCEndRate: 2,
      contribution: 0.375,
    },
    {
      index: 4,
      startTime: 40,
      endTime: 60,
      durationSeconds: 20,
      source: 'probeA',
      tie: ['probeA'],
      startOrder: ['probeC', 'probeA', 'probeB'],
      endOrder: ['probeC', 'probeA', 'probeB'],
      reason: '中段速率由低到高：探头C < 探头A < 探头B；中位曲线为探头A',
      startRate: 2,
      endRate: 2,
      probeAStartRate: 2,
      probeAEndRate: 2,
      probeBStartRate: 3,
      probeBEndRate: 4,
      probeCStartRate: 2,
      probeCEndRate: 1,
      contribution: 2 / 3,
    },
  ],
};

// 并列中位的响应：B、C 重合并列中位，固定顺序裁决取 probeB
const tripleTieResponse = {
  ...tripleCrossingResponse,
  passed: true,
  medianUnrounded: 3.0,
  medianF0: 3.0,
  shortfall: null,
  segments: [
    {
      ...tripleCrossingResponse.segments[0],
      index: 1,
      endTime: 60,
      durationSeconds: 60,
      source: 'probeB',
      tie: ['probeB', 'probeC'],
      startOrder: ['probeA', 'probeB', 'probeC'],
      endOrder: ['probeA', 'probeB', 'probeC'],
      reason:
        '中段速率由低到高：探头A < 探头B = 探头C；中位在探头B、探头C间并列，按固定顺序 A→B→C 裁决取探头B',
      endRate: 3,
      probeBEndRate: 3,
      probeCEndRate: 3,
      contribution: 3.0,
    },
  ],
};

function mockFetchResponse(status, body) {
  fetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openTriple(user) {
  await user.click(screen.getByRole('tab', { name: '三探头中位复核' }));
}

describe('三探头录入', () => {
  it('并列渲染三支探头录入表，各首行从 0 秒开始、结束于同一秒', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTriple(user);

    expect(screen.getByLabelText('探头A 时间 第1行')).toHaveValue('0');
    expect(screen.getByLabelText('探头B 时间 第1行')).toHaveValue('0');
    expect(screen.getByLabelText('探头C 时间 第1行')).toHaveValue('0');
    const lastTimes = ['探头A', '探头B', '探头C'].map((name) => {
      const inputs = screen.getAllByLabelText(new RegExp(`^${name} 时间`));
      return inputs.at(-1).value;
    });
    expect(lastTimes[0]).toBe(lastTimes[1]);
    expect(lastTimes[1]).toBe(lastTimes[2]);
  });

  it('提交体携带 probeA/probeB/probeC 三路采样点', async () => {
    const user = userEvent.setup();
    mockFetchResponse(200, tripleCrossingResponse);
    render(<App />);
    await openTriple(user);
    await user.click(screen.getByTestId('triple-submit'));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/lethality/triple');
    const body = JSON.parse(options.body);
    expect(body.probeA.points).toHaveLength(6);
    expect(body.probeB.points).toHaveLength(5);
    expect(body.probeC.points).toHaveLength(6);
    expect(body.probeA.points[0]).toEqual({ time: 0, temperature: 124.11 });
    expect(body.probeC.points.at(-1)).toEqual({ time: 180, temperature: 127.12 });
  });
});

describe('三探头结果展示：图形与明细同一响应', () => {
  it('展示中位结论、三探头总量、逐段来源与裁决原因', async () => {
    const user = userEvent.setup();
    mockFetchResponse(200, tripleCrossingResponse);
    render(<App />);
    await openTriple(user);
    await user.click(screen.getByTestId('triple-submit'));

    const conclusion = await screen.findByTestId('triple-conclusion');
    expect(conclusion).toHaveTextContent('不放行');
    expect(conclusion).toHaveTextContent((25 / 12).toFixed(6));

    const totals = screen.getByTestId('triple-totals');
    expect(totals).toHaveTextContent('探头A 总量');
    expect(totals).toHaveTextContent('探头B 总量');
    expect(totals).toHaveTextContent('探头C 总量');
    expect(totals).toHaveTextContent('不是三份总 F₀ 的中位数');

    const panel = screen.getByLabelText('三探头中位复核结果');
    const rows = within(panel).getAllByRole('row');
    // 表头 + 4 中位段 + 合计
    expect(rows).toHaveLength(6);
    expect(rows[1]).toHaveTextContent('探头A');
    expect(rows[2]).toHaveTextContent('探头B');
    expect(rows[3]).toHaveTextContent('探头C');
    expect(rows[4]).toHaveTextContent('探头A');
    expect(rows[1]).toHaveTextContent('0.000 → 20.000');
    expect(rows[2]).toHaveTextContent('20.000 → 30.000');
    expect(rows[3]).toHaveTextContent('30.000 → 40.000');
    expect(rows[4]).toHaveTextContent('40.000 → 60.000');
    // 每段说明为何由该探头贡献
    expect(rows[1]).toHaveTextContent('中位曲线为探头A');
    expect(rows[2]).toHaveTextContent('中位曲线为探头B');
    expect(rows[3]).toHaveTextContent('中位曲线为探头C');
    // 每段回传三探头各自速率
    expect(rows[2]).toHaveTextContent('2.000000 → 2.500000');

    // 合计为各段贡献未舍入之和（同一响应复算）
    const contributions = await Promise.all(
      [1, 2, 3, 4].map(
        async (i) => (await within(panel).findByTestId(`triple-seg-${i}`)).textContent,
      ),
    );
    const summed = contributions.reduce((acc, text) => acc + Number(text), 0);
    const shown = Number((await within(panel).findByTestId('triple-total')).textContent);
    expect(Math.abs(summed - shown)).toBeLessThan(1e-5);

    // 图形与表格同源：SVG 渲染三探头线与中位段
    await expect(
      screen.getByLabelText('三探头致死速率曲线与逐刻中位曲线'),
    ).toBeInTheDocument();
  });

  it('并列中位段标注并列探头并说明固定顺序裁决', async () => {
    const user = userEvent.setup();
    mockFetchResponse(200, tripleTieResponse);
    render(<App />);
    await openTriple(user);
    await user.click(screen.getByTestId('triple-submit'));

    const panel = await screen.findByLabelText('三探头中位复核结果');
    const row = within(panel).getAllByRole('row')[1];
    expect(row).toHaveTextContent('探头B');
    expect(row).toHaveTextContent('并列：探头B、探头C');
    expect(row).toHaveTextContent('固定顺序 A→B→C 裁决取探头B');
    expect(row).toHaveAttribute('data-source', 'probeB');
  });

  it('未舍入中位总量低于门槛但展示为 3.00 时仍判不放行', async () => {
    const user = userEvent.setup();
    const boundary = {
      ...tripleTieResponse,
      passed: false,
      medianUnrounded: 2.99996,
      medianF0: 3.0,
      shortfall: 0.00004,
    };
    mockFetchResponse(200, boundary);
    render(<App />);
    await openTriple(user);
    await user.click(screen.getByTestId('triple-submit'));

    const conclusion = await screen.findByTestId('triple-conclusion');
    expect(conclusion).toHaveTextContent('不放行');
    expect(conclusion).toHaveTextContent('2.999960');
    expect(conclusion).toHaveTextContent('展示口径 3.00');
    expect(conclusion).toHaveTextContent('尚差 0.000040');
  });
});

describe('三探头失败隔离', () => {
  it('第三路缺样 422：按探头C展示错误且保留上一份有效报告', async () => {
    const user = userEvent.setup();
    mockFetchResponse(200, tripleTieResponse);
    render(<App />);
    await openTriple(user);
    await user.click(screen.getByTestId('triple-submit'));
    expect(await screen.findByTestId('triple-conclusion')).toBeInTheDocument();

    // 第二提交：探头C 第 2 行非法（间隔 61 秒）→ 422
    mockFetchResponse(422, {
      detail: {
        message: '采样数据校验失败',
        errors: [
          { row: 2, field: 'time', probe: 'probeC', message: '相邻采样间隔不得超过 60 秒' },
        ],
      },
    });
    await user.click(screen.getByTestId('triple-submit'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('探头C');
    expect(alert).toHaveTextContent('第 2 行');
    expect(alert).toHaveTextContent('60 秒');
    // 上一份有效报告仍然显示，未被覆盖
    expect(screen.getByTestId('triple-conclusion')).toBeInTheDocument();
    expect(screen.getByTestId('triple-total')).toHaveTextContent('3.000000');
  });

  it('三探头结束秒不一致：整体拒绝并保留上一份报告', async () => {
    const user = userEvent.setup();
    mockFetchResponse(200, tripleTieResponse);
    render(<App />);
    await openTriple(user);
    await user.click(screen.getByTestId('triple-submit'));
    await screen.findByTestId('triple-conclusion');

    mockFetchResponse(422, {
      detail: {
        message: '采样数据校验失败',
        errors: [
          { row: null, field: 'probe', probe: null, message: '三支探头必须结束于同一秒（探头A结束于 60 秒，探头B结束于 60 秒，探头C结束于 59 秒）' },
        ],
      },
    });
    await user.click(screen.getByTestId('triple-submit'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('三支探头必须结束于同一秒');
    expect(screen.getByTestId('triple-conclusion')).toBeInTheDocument();
  });

  it('三探头失败不影响已显示的单探头结论', async () => {
    const user = userEvent.setup();
    const singlePassing = {
      f0: 3.0,
      threshold: 3.0,
      passed: true,
      shortfall: null,
      segments: [
        { index: 1, startTime: 0, endTime: 180, startTemperature: 121.1, endTemperature: 121.1, startRate: 1, endRate: 1, durationSeconds: 180, contribution: 3 },
      ],
    };
    mockFetchResponse(200, singlePassing);
    render(<App />);
    await user.click(screen.getByRole('button', { name: '计算致死量' }));
    expect(await screen.findByTestId('conclusion')).toHaveTextContent('放行');

    await openTriple(user);
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await user.click(screen.getByTestId('triple-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法连接服务器');

    await user.click(screen.getByRole('tab', { name: '单探头复核' }));
    expect(screen.getByTestId('conclusion')).toHaveTextContent('放行');
  });
});

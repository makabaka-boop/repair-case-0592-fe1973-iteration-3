import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, calculateTripleLethality } from '../api.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const tripleResponse = {
  threshold: 3.0,
  probeA: {
    probe: 'probeA',
    points: [{ time: 0, temperature: 121.1, rate: 1 }],
    totalUnrounded: 1.0,
    f0: 1.0,
  },
  probeB: {
    probe: 'probeB',
    points: [{ time: 0, temperature: 121.1, rate: 1 }],
    totalUnrounded: 1.0,
    f0: 1.0,
  },
  probeC: {
    probe: 'probeC',
    points: [{ time: 0, temperature: 121.1, rate: 1 }],
    totalUnrounded: 1.0,
    f0: 1.0,
  },
  probeATotalUnrounded: 1.0,
  probeBTotalUnrounded: 1.0,
  probeCTotalUnrounded: 1.0,
  probeAF0: 1.0,
  probeBF0: 1.0,
  probeCF0: 1.0,
  medianUnrounded: 1.0,
  medianF0: 1.0,
  passed: false,
  shortfall: 2.0,
  segments: [
    {
      index: 1,
      startTime: 0,
      endTime: 60,
      durationSeconds: 60,
      source: 'probeA',
      tie: ['probeA', 'probeB', 'probeC'],
      startOrder: ['probeA', 'probeB', 'probeC'],
      endOrder: ['probeA', 'probeB', 'probeC'],
      reason: '中段速率由低到高：探头A = 探头B = 探头C；中位在探头A、探头B、探头C间并列，按固定顺序 A→B→C 裁决取探头A',
      startRate: 1,
      endRate: 1,
      probeAStartRate: 1,
      probeAEndRate: 1,
      probeBStartRate: 1,
      probeBEndRate: 1,
      probeCStartRate: 1,
      probeCEndRate: 1,
      contribution: 1.0,
    },
  ],
};

describe('calculateTripleLethality', () => {
  it('以 POST JSON 调用 /api/lethality/triple 并返回结果', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => tripleResponse,
    });

    const result = await calculateTripleLethality(
      [{ time: 0, temperature: 121.1 }],
      [{ time: 0, temperature: 121.1 }],
      [{ time: 0, temperature: 121.1 }],
    );

    expect(result).toEqual(tripleResponse);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/lethality/triple');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      probeA: { points: [{ time: 0, temperature: 121.1 }] },
      probeB: { points: [{ time: 0, temperature: 121.1 }] },
      probeC: { points: [{ time: 0, temperature: 121.1 }] },
    });
  });

  it('第三路缺样 422 时抛出携带 probeC 的 ApiError', async () => {
    const errors = [
      { row: null, field: 'probeC', probe: 'probeC', message: '探头C必须为包含 points 数组的对象' },
    ];
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ detail: { message: '采样数据校验失败', errors } }),
    });

    const error = await calculateTripleLethality([], [], []).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.errors).toEqual(errors);
  });

  it('网络异常时抛出带提示的 ApiError', async () => {
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const error = await calculateTripleLethality([], [], []).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.errors[0].message).toContain('无法连接服务器');
  });
});

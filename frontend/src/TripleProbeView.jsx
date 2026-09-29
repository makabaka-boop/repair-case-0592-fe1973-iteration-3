import { useState } from 'react';
import { ApiError, calculateTripleLethality } from './api.js';
import { fieldLabel, formatMinutes } from './format.js';
import TripleChart, { SOURCE_STYLE } from './TripleChart.jsx';
import ProbeEditorTable, { PROBE_LABELS } from './ProbeEditorTable.jsx';

const PROBES = ['probeA', 'probeB', 'probeC'];

// 默认示例：0–60 s 三支探头采样时刻不同、速率线多次交叉（速率等价于
// A 2→1→7→7、B 2→1→2、C 7→7→1→1），60 s 后三支同温 127.12 °C 保持
// 120 s：前段演示逐刻中位在探头间切换，整批中位总量远高于 3.00 min 门槛。
const DEFAULT_ROWS = {
  probeA: [
    { time: '0', temperature: '124.11' },
    { time: '20', temperature: '121.1' },
    { time: '40', temperature: '129.55' },
    { time: '60', temperature: '129.55' },
    { time: '120', temperature: '127.12' },
    { time: '180', temperature: '127.12' },
  ],
  probeB: [
    { time: '0', temperature: '124.11' },
    { time: '30', temperature: '121.1' },
    { time: '60', temperature: '124.11' },
    { time: '120', temperature: '127.12' },
    { time: '180', temperature: '127.12' },
  ],
  probeC: [
    { time: '0', temperature: '129.55' },
    { time: '20', temperature: '129.55' },
    { time: '40', temperature: '121.1' },
    { time: '60', temperature: '121.1' },
    { time: '120', temperature: '127.12' },
    { time: '180', temperature: '127.12' },
  ],
};

function probeName(probe) {
  return PROBE_LABELS[probe] ?? probe;
}

function toPoints(rows) {
  return rows.map((row) => ({
    time: row.time.trim() === '' ? null : Number(row.time),
    temperature: row.temperature.trim() === '' ? null : Number(row.temperature),
  }));
}

function RatePair({ start, end }) {
  return (
    <>
      {formatMinutes(start, 6)} → {formatMinutes(end, 6)}
    </>
  );
}

function MedianPanel({ result }) {
  return (
    <section
      className={`result triple-result ${result.passed ? 'pass' : 'fail'}`}
      aria-label="三探头中位复核结果"
    >
      <h2>三探头中位复核结论</h2>
      <p className="conclusion" data-testid="triple-conclusion">
        {result.passed
          ? `放行：中位 F₀ = ${formatMinutes(result.medianUnrounded, 6)} min（展示口径 ${formatMinutes(result.medianF0)}），达到 ${formatMinutes(result.threshold)} min 门槛`
          : `不放行：中位 F₀ = ${formatMinutes(result.medianUnrounded, 6)} min（展示口径 ${formatMinutes(result.medianF0)}），距 ${formatMinutes(result.threshold)} min 门槛尚差 ${formatMinutes(result.shortfall, 6)} min`}
      </p>
      <p className="totals" data-testid="triple-totals">
        探头A 总量 {formatMinutes(result.probeATotalUnrounded, 6)} min（F₀{' '}
        {formatMinutes(result.probeAF0)}）　·　探头B 总量{' '}
        {formatMinutes(result.probeBTotalUnrounded, 6)} min（F₀{' '}
        {formatMinutes(result.probeBF0)}）　·　探头C 总量{' '}
        {formatMinutes(result.probeCTotalUnrounded, 6)} min（F₀{' '}
        {formatMinutes(result.probeCF0)}）　·　中位总量取<strong>每一刻</strong>
        三支探头速率的中位值积分，不是三份总 F₀ 的中位数
      </p>

      <TripleChart result={result} />

      <table className="segments triple-segments">
        <thead>
          <tr>
            <th>中位段</th>
            <th>时间区间 (s)</th>
            <th>间隔 (s)</th>
            <th>来源探头</th>
            <th>中位速率 起→止</th>
            <th>探头A 速率 起→止</th>
            <th>探头B 速率 起→止</th>
            <th>探头C 速率 起→止</th>
            <th>为何由该探头贡献</th>
            <th>段贡献 (min)</th>
          </tr>
        </thead>
        <tbody>
          {result.segments.map((seg) => (
            <tr key={seg.index} data-source={seg.source}>
              <td>{seg.index}</td>
              <td>
                {formatMinutes(seg.startTime, 3)} → {formatMinutes(seg.endTime, 3)}
              </td>
              <td>{formatMinutes(seg.durationSeconds, 3)}</td>
              <td>
                <span className={`source-badge source-${seg.source}`}>
                  {SOURCE_STYLE[seg.source].label}
                </span>
                {seg.tie.length > 1 && (
                  <span className="tie-note">并列：{seg.tie.map(probeName).join('、')}</span>
                )}
              </td>
              <td>
                <RatePair start={seg.startRate} end={seg.endRate} />
              </td>
              <td>
                <RatePair start={seg.probeAStartRate} end={seg.probeAEndRate} />
              </td>
              <td>
                <RatePair start={seg.probeBStartRate} end={seg.probeBEndRate} />
              </td>
              <td>
                <RatePair start={seg.probeCStartRate} end={seg.probeCEndRate} />
              </td>
              <td className="reason-cell" title={seg.reason}>
                {seg.reason}
              </td>
              <td data-testid={`triple-seg-${seg.index}`}>
                {formatMinutes(seg.contribution, 6)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={9}>中位合计（各段未舍入累加；放行以此值比较门槛）</td>
            <td data-testid="triple-total">{formatMinutes(result.medianUnrounded, 6)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

export default function TripleProbeView() {
  const [rowsByProbe, setRowsByProbe] = useState(DEFAULT_ROWS);
  const [result, setResult] = useState(null);
  const [errors, setErrors] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  // 第三路缺样/非法或请求失败只拒绝本次分析：保留上一份有效报告
  // （result 不清空），单/双探头结论由各自组件单独持有，互不影响。
  const errorRows = (probe) =>
    new Set(
      errors
        .filter((e) => e.probe === probe && e.row != null)
        .map((e) => e.row),
    );

  const updateCell = (probe, index, field, value) => {
    setRowsByProbe((current) => ({
      ...current,
      [probe]: current[probe].map((row, i) =>
        i === index ? { ...row, [field]: value } : row,
      ),
    }));
  };

  const addRow = (probe) => {
    setRowsByProbe((current) => {
      const rows = current[probe];
      const last = rows[rows.length - 1];
      const lastTime = last ? Number(last.time) : NaN;
      const canSuggest =
        last && last.time.trim() !== '' && Number.isFinite(lastTime);
      return {
        ...current,
        [probe]: [
          ...rows,
          {
            time: canSuggest ? String(lastTime + 10) : '',
            temperature: last ? last.temperature : '',
          },
        ],
      };
    });
  };

  const removeRow = (probe, index) => {
    setRowsByProbe((current) => ({
      ...current,
      [probe]: current[probe].filter((_, i) => i !== index),
    }));
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const data = await calculateTripleLethality(
        toPoints(rowsByProbe.probeA),
        toPoints(rowsByProbe.probeB),
        toPoints(rowsByProbe.probeC),
      );
      setResult(data);
      setErrors([]);
    } catch (err) {
      // 只拒绝本次分析：不清空上一份有效报告
      setErrors(
        err instanceof ApiError
          ? err.errors
          : [{ row: null, field: null, probe: null, message: '请求失败，请稍后重试' }],
      );
    } finally {
      setSubmitting(false);
    }
  };

  const generalErrors = errors.filter((e) => e.row == null);
  const rowErrors = errors.filter((e) => e.row != null);

  return (
    <section className="triple-view">
      <p className="hint">
        三支探头各自从 0 秒开始、结束于同一秒，分别遵守时间严格递增、相邻间隔 ≤ 60
        秒与温度 100.0–140.0 °C 的校验。后端在三组采样时刻的共同时间域上插值三条
        致死速率线，按采样节点与<strong>两两交点</strong>切分时间段，逐段按
        <strong>每一刻三支探头速率的中位值</strong>积分；并列中位按固定探头顺序
        A→B→C 裁决。放行只用未舍入的中位总量。
      </p>

      <div className="probe-grid probe-grid-3">
        {PROBES.map((probe) => (
          <ProbeEditorTable
            key={probe}
            probe={probe}
            rows={rowsByProbe[probe]}
            errorRows={errorRows(probe)}
            onChange={updateCell}
            onAdd={addRow}
            onRemove={removeRow}
          />
        ))}
      </div>

      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={submit}
          disabled={submitting}
          data-testid="triple-submit"
        >
          {submitting ? '三探头计算中…' : '计算三探头中位 F₀'}
        </button>
      </div>

      {errors.length > 0 && (
        <section className="errors" role="alert" aria-label="三探头校验错误">
          <h2>本次三探头分析被拒绝（已保留上一份有效报告，不影响单/双探头结论）</h2>
          <ul>
            {[...generalErrors, ...rowErrors].map((error, i) => {
              const prefix = error.probe ? `${probeName(error.probe)} · ` : '';
              const rowPart = error.row != null ? `第 ${error.row} 行 · ` : '';
              return (
                <li key={i}>
                  {prefix}
                  {rowPart}
                  {fieldLabel(error.field)}：{error.message}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {result && <MedianPanel result={result} />}
    </section>
  );
}

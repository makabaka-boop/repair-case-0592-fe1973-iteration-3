import { useState } from 'react';
import { ApiError, calculateDualLethality } from './api.js';
import { fieldLabel, formatMinutes } from './format.js';
import ProbeChart, { SOURCE_STYLE } from './ProbeChart.jsx';

const MIN_ROWS = 2;

// 默认示例：两支探头采样时刻不一致且速率线多次换源，
// 用于直接演示并集插值与交点拆段；保守总量高于 3.00 min 门槛，判放行。
const DEFAULT_PROBE_A = [
  { time: '0', temperature: '126.0' },
  { time: '30', temperature: '123.0' },
  { time: '60', temperature: '121.0' },
  { time: '90', temperature: '124.0' },
  { time: '120', temperature: '127.0' },
];
const DEFAULT_PROBE_B = [
  { time: '0', temperature: '123.0' },
  { time: '45', temperature: '127.0' },
  { time: '90', temperature: '123.0' },
  { time: '120', temperature: '127.0' },
];

function toPoints(rows) {
  return rows.map((row) => ({
    time: row.time.trim() === '' ? null : Number(row.time),
    temperature: row.temperature.trim() === '' ? null : Number(row.temperature),
  }));
}

function probeName(probe) {
  return probe === 'probeA' ? '探头A' : '探头B';
}

function ProbeTable({ probe, rows, errorRows, onChange, onAdd, onRemove }) {
  return (
    <div className="probe-editor">
      <h3>{probeName(probe)}</h3>
      <table className="samples">
        <thead>
          <tr>
            <th>行</th>
            <th>时间 (秒)</th>
            <th>温度 (°C)</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={index}
              className={errorRows.has(index + 1) ? 'row-error' : undefined}
            >
              <td className="row-index">{index + 1}</td>
              <td>
                <input
                  aria-label={`${probeName(probe)} 时间 第${index + 1}行`}
                  inputMode="numeric"
                  value={row.time}
                  onChange={(e) => onChange(probe, index, 'time', e.target.value)}
                />
              </td>
              <td>
                <input
                  aria-label={`${probeName(probe)} 温度 第${index + 1}行`}
                  inputMode="decimal"
                  value={row.temperature}
                  onChange={(e) =>
                    onChange(probe, index, 'temperature', e.target.value)
                  }
                />
              </td>
              <td>
                <button
                  type="button"
                  aria-label={`${probeName(probe)} 删除 第${index + 1}行`}
                  onClick={() => onRemove(probe, index)}
                  disabled={rows.length <= MIN_ROWS}
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="add-row" onClick={() => onAdd(probe)}>
        添加采样行
      </button>
    </div>
  );
}

function ConservativePanel({ result }) {
  return (
    <section
      className={`result dual-result ${result.passed ? 'pass' : 'fail'}`}
      aria-label="双探头保守复核结果"
    >
      <h2>双探头保守复核结论</h2>
      <p className="conclusion" data-testid="dual-conclusion">
        {result.passed
          ? `放行：保守 F₀ = ${formatMinutes(result.conservativeUnrounded, 6)} min（展示口径 ${formatMinutes(result.conservativeF0)}），达到 ${formatMinutes(result.threshold)} min 门槛`
          : `不放行：保守 F₀ = ${formatMinutes(result.conservativeUnrounded, 6)} min（展示口径 ${formatMinutes(result.conservativeF0)}），距 ${formatMinutes(result.threshold)} min 门槛尚差 ${formatMinutes(result.shortfall, 6)} min`}
      </p>
      <p className="totals" data-testid="dual-totals">
        探头A 总量 {formatMinutes(result.probeATotalUnrounded, 6)} min（F₀{' '}
        {formatMinutes(result.probeAF0)}）　·　探头B 总量{' '}
        {formatMinutes(result.probeBTotalUnrounded, 6)} min（F₀{' '}
        {formatMinutes(result.probeBF0)}）　·　保守总量取每一刻较低速率积分，
        不是两份总量的较小值
      </p>

      <ProbeChart result={result} />

      <table className="segments dual-segments">
        <thead>
          <tr>
            <th>保守段</th>
            <th>时间区间 (s)</th>
            <th>间隔 (s)</th>
            <th>来源探头</th>
            <th>下包络速率 起→止</th>
            <th>探头A 速率 起→止</th>
            <th>探头B 速率 起→止</th>
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
              </td>
              <td>
                {formatMinutes(seg.startRate, 6)} → {formatMinutes(seg.endRate, 6)}
              </td>
              <td>
                {formatMinutes(seg.probeAStartRate, 6)} →{' '}
                {formatMinutes(seg.probeAEndRate, 6)}
              </td>
              <td>
                {formatMinutes(seg.probeBStartRate, 6)} →{' '}
                {formatMinutes(seg.probeBEndRate, 6)}
              </td>
              <td data-testid={`dual-seg-${seg.index}`}>
                {formatMinutes(seg.contribution, 6)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={7}>保守合计（各段未舍入累加；放行以此值比较门槛）</td>
            <td data-testid="dual-total">{formatMinutes(result.conservativeUnrounded, 6)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

export default function DualProbeView() {
  const [rowsA, setRowsA] = useState(DEFAULT_PROBE_A);
  const [rowsB, setRowsB] = useState(DEFAULT_PROBE_B);
  const [result, setResult] = useState(null);
  const [errors, setErrors] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  // 双探头失败只清除本次比较（result 置空），
  // 单探头结论由父组件单独持有，互不影响。
  const errorRows = (probe) =>
    new Set(
      errors
        .filter((e) => e.probe === probe && e.row != null)
        .map((e) => e.row),
    );

  const updateCell = (probe, index, field, value) => {
    const setter = probe === 'probeA' ? setRowsA : setRowsB;
    setter((current) =>
      current.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  };

  const addRow = (probe) => {
    const setter = probe === 'probeA' ? setRowsA : setRowsB;
    const rows = probe === 'probeA' ? rowsA : rowsB;
    const last = rows[rows.length - 1];
    const lastTime = last ? Number(last.time) : NaN;
    const canSuggest =
      last && last.time.trim() !== '' && Number.isFinite(lastTime);
    setter((current) => [
      ...current,
      {
        time: canSuggest ? String(lastTime + 30) : '',
        temperature: last ? last.temperature : '',
      },
    ]);
  };

  const removeRow = (probe, index) => {
    const setter = probe === 'probeA' ? setRowsA : setRowsB;
    setter((current) => current.filter((_, i) => i !== index));
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const data = await calculateDualLethality(toPoints(rowsA), toPoints(rowsB));
      setResult(data);
      setErrors([]);
    } catch (err) {
      // 双探头输入或请求失败：只清除本次双探头比较
      setResult(null);
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
    <section className="dual-view">
      <p className="hint">
        两支探头各自从 0 秒开始、结束于同一秒，分别遵守时间严格递增、相邻间隔 ≤ 60
        秒与温度 100.0–140.0 °C 的校验。后端在两组采样时刻的并集上插值两条致死速率线，
        在交点拆段后对<strong>每一刻较低</strong>的速率（下包络）积分；放行只用未舍入的保守总量。
      </p>

      <div className="probe-grid">
        <ProbeTable
          probe="probeA"
          rows={rowsA}
          errorRows={errorRows('probeA')}
          onChange={updateCell}
          onAdd={addRow}
          onRemove={removeRow}
        />
        <ProbeTable
          probe="probeB"
          rows={rowsB}
          errorRows={errorRows('probeB')}
          onChange={updateCell}
          onAdd={addRow}
          onRemove={removeRow}
        />
      </div>

      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={submit}
          disabled={submitting}
          data-testid="dual-submit"
        >
          {submitting ? '双探头计算中…' : '计算双探头保守 F₀'}
        </button>
      </div>

      {errors.length > 0 && (
        <section className="errors" role="alert" aria-label="双探头校验错误">
          <h2>本次双探头比较被拒绝（已清除本次比较，不影响单探头结论）</h2>
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

      {result && <ConservativePanel result={result} />}
    </section>
  );
}

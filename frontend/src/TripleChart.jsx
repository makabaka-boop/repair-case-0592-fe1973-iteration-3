/**
 * 三探头速率曲线图：三支探头各自的分段线性速率线 + 逐刻中位曲线段。
 *
 * 所有数据都来自 /api/lethality/triple 的同一份响应：
 * - 探头折线取 probeA/probeB/probeC 的采样点速率；
 * - 中位粗线取 segments（并集时刻与两两交点已切分），按裁决来源着色；
 * - 并列中位（tie 多于一支）在粗线下加深色衬底并在悬停提示中列出并列探头。
 * 表格与图形因此永远同源，不会出现图形与明细对不上的情况。
 */

const WIDTH = 720;
const HEIGHT = 320;
const MARGIN = { top: 20, right: 24, bottom: 44, left: 56 };

const SOURCE_STYLE = {
  probeA: { color: '#0b6bcb', label: '探头A', dash: '6 3' },
  probeB: { color: '#c05a00', label: '探头B', dash: '2 3' },
  probeC: { color: '#1e8e4a', label: '探头C', dash: '10 4' },
};

function niceCeil(value) {
  if (value <= 1) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / pow;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * pow;
}

function tieLabel(tie) {
  return tie.map((probe) => SOURCE_STYLE[probe].label).join('、');
}

export default function TripleChart({ result }) {
  const probePoints = [result.probeA.points, result.probeB.points, result.probeC.points];
  const maxTime = Math.max(...probePoints.map((points) => points.at(-1).time));
  const maxRate = niceCeil(
    Math.max(...probePoints.flat().map((pt) => pt.rate)),
  );

  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const x = (t) => MARGIN.left + (Number(t) / maxTime) * plotW;
  const y = (r) => MARGIN.top + plotH - (Math.min(r, maxRate) / maxRate) * plotH;

  const linePath = (points) =>
    points
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${x(pt.time)} ${y(pt.rate)}`)
      .join(' ');

  const gridRates = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxRate);
  const tickCount = 6;
  const gridTimes = Array.from({ length: tickCount + 1 }, (_, i) =>
    Math.round((maxTime / tickCount) * i),
  );

  return (
    <svg
      className="probe-chart"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label="三探头致死速率曲线与逐刻中位曲线"
    >
      {gridRates.map((r) => (
        <g key={`r${r}`}>
          <line
            x1={MARGIN.left}
            x2={WIDTH - MARGIN.right}
            y1={y(r)}
            y2={y(r)}
            stroke="#e2e8f0"
          />
          <text x={MARGIN.left - 8} y={y(r) + 4} textAnchor="end" fontSize="11">
            {Number(r.toFixed(3))}
          </text>
        </g>
      ))}
      {gridTimes.map((t) => (
        <g key={`t${t}`}>
          <line
            y1={MARGIN.top}
            y2={HEIGHT - MARGIN.bottom}
            x1={x(t)}
            x2={x(t)}
            stroke="#f0f3f7"
          />
          <text x={x(t)} y={HEIGHT - MARGIN.bottom + 18} textAnchor="middle" fontSize="11">
            {t}s
          </text>
        </g>
      ))}

      {/* 坐标轴 */}
      <line
        x1={MARGIN.left}
        x2={MARGIN.left}
        y1={MARGIN.top}
        y2={HEIGHT - MARGIN.bottom}
        stroke="#94a3b8"
      />
      <line
        x1={MARGIN.left}
        x2={WIDTH - MARGIN.right}
        y1={HEIGHT - MARGIN.bottom}
        y2={HEIGHT - MARGIN.bottom}
        stroke="#94a3b8"
      />
      <text x={MARGIN.left - 40} y={MARGIN.top - 6} fontSize="11">
        致死速率
      </text>

      {/* 三探头速率折线（细线） */}
      {(['probeA', 'probeB', 'probeC']).map((probe) => (
        <path
          key={probe}
          d={linePath(result[probe].points)}
          fill="none"
          stroke={SOURCE_STYLE[probe].color}
          strokeWidth="1.6"
          strokeDasharray={SOURCE_STYLE[probe].dash}
        />
      ))}

      {/* 逐刻中位：按拆段裁决来源逐段画粗线；并列段加深色衬底 */}
      {result.segments.map((seg) => (
        <g key={`med${seg.index}`}>
          {seg.tie.length > 1 && (
            <line
              x1={x(seg.startTime)}
              y1={y(seg.startRate)}
              x2={x(seg.endTime)}
              y2={y(seg.endRate)}
              stroke="#1f2933"
              strokeWidth="6.5"
              strokeLinecap="butt"
            />
          )}
          <line
            x1={x(seg.startTime)}
            y1={y(seg.startRate)}
            x2={x(seg.endTime)}
            y2={y(seg.endRate)}
            stroke={SOURCE_STYLE[seg.source].color}
            strokeWidth="4"
            strokeLinecap="butt"
          >
            <title>
              {`第${seg.index}段 · 中位来源：${SOURCE_STYLE[seg.source].label}` +
                (seg.tie.length > 1 ? `（并列：${tieLabel(seg.tie)}）` : '') +
                ` · 贡献 ${seg.contribution.toFixed(6)} min · ${seg.reason}`}
            </title>
          </line>
        </g>
      ))}

      {/* 来源切换/交点边界标记：每个内部片段边界 */}
      {result.segments.slice(1).map((seg) => (
        <circle
          key={`boundary${seg.index}`}
          cx={x(seg.startTime)}
          cy={y(seg.startRate)}
          r="3.5"
          fill="#fff"
          stroke="#1f2933"
          strokeWidth="1.5"
        />
      ))}

      {/* 图例 */}
      <g transform={`translate(${MARGIN.left + 8}, ${MARGIN.top + 4})`}>
        <rect width="178" height="76" rx="4" fill="#ffffffcc" stroke="#d9e2ec" />
        <line x1="8" y1="14" x2="34" y2="14"
          stroke={SOURCE_STYLE.probeA.color} strokeWidth="1.6"
          strokeDasharray={SOURCE_STYLE.probeA.dash} />
        <text x="40" y="18" fontSize="11">探头A 速率线</text>
        <line x1="8" y1="32" x2="34" y2="32"
          stroke={SOURCE_STYLE.probeB.color} strokeWidth="1.6"
          strokeDasharray={SOURCE_STYLE.probeB.dash} />
        <text x="40" y="36" fontSize="11">探头B 速率线</text>
        <line x1="8" y1="50" x2="34" y2="50"
          stroke={SOURCE_STYLE.probeC.color} strokeWidth="1.6"
          strokeDasharray={SOURCE_STYLE.probeC.dash} />
        <text x="40" y="54" fontSize="11">探头C 速率线</text>
        <line x1="8" y1="68" x2="34" y2="68" stroke="#1f2933" strokeWidth="4" />
        <text x="40" y="72" fontSize="11">逐刻中位（按来源着色）</text>
      </g>
    </svg>
  );
}

export { SOURCE_STYLE };

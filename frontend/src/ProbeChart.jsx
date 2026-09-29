/**
 * 双探头速率曲线图：两支探头各自的分段线性速率线 + 保守下包络段。
 *
 * 所有数据都来自 /api/lethality/dual 的同一份响应：
 * - 探头折线取 probeA/probeB 的采样点速率；
 * - 下包络粗线取 segments（在交点处已拆段），按来源探头着色。
 * 表格与图形因此永远同源，不会出现图形与明细对不上的情况。
 */

const WIDTH = 720;
const HEIGHT = 320;
const MARGIN = { top: 20, right: 24, bottom: 44, left: 56 };

const SOURCE_STYLE = {
  probeA: { color: '#0b6bcb', label: '探头A' },
  probeB: { color: '#c05a00', label: '探头B' },
  both: { color: '#5b3ea6', label: '两探头重合' },
};

function niceCeil(value) {
  if (value <= 1) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / pow;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * pow;
}

export default function ProbeChart({ result }) {
  const aPoints = result.probeA.points;
  const bPoints = result.probeB.points;
  const maxTime = Math.max(aPoints.at(-1).time, bPoints.at(-1).time);
  const maxRate = niceCeil(
    Math.max(...aPoints.map((p) => p.rate), ...bPoints.map((p) => p.rate)),
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
      aria-label="双探头致死速率曲线与保守下包络"
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

      {/* 两探头速率折线（细线） */}
      <path d={linePath(aPoints)} fill="none" stroke={SOURCE_STYLE.probeA.color}
        strokeWidth="1.6" strokeDasharray="6 3" />
      <path d={linePath(bPoints)} fill="none" stroke={SOURCE_STYLE.probeB.color}
        strokeWidth="1.6" strokeDasharray="2 3" />

      {/* 保守下包络：按拆段来源逐段画粗线 */}
      {result.segments.map((seg) => (
        <line
          key={`env${seg.index}`}
          x1={x(seg.startTime)}
          y1={y(seg.startRate)}
          x2={x(seg.endTime)}
          y2={y(seg.endRate)}
          stroke={SOURCE_STYLE[seg.source].color}
          strokeWidth="4"
          strokeLinecap="butt"
        >
          <title>
            {`第${seg.index}段 · ${SOURCE_STYLE[seg.source].label}保守贡献 ${seg.contribution.toFixed(6)} min`}
          </title>
        </line>
      ))}

      {/* 交点标记：来源切换的内部时刻 */}
      {result.segments.slice(1).map((seg) => (
        <circle
          key={`cross${seg.index}`}
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
        <rect width="150" height="58" rx="4" fill="#ffffffcc" stroke="#d9e2ec" />
        <line x1="8" y1="14" x2="34" y2="14"
          stroke={SOURCE_STYLE.probeA.color} strokeWidth="1.6" strokeDasharray="6 3" />
        <text x="40" y="18" fontSize="11">探头A 速率线</text>
        <line x1="8" y1="32" x2="34" y2="32"
          stroke={SOURCE_STYLE.probeB.color} strokeWidth="1.6" strokeDasharray="2 3" />
        <text x="40" y="36" fontSize="11">探头B 速率线</text>
        <line x1="8" y1="50" x2="34" y2="50" stroke="#1f2933" strokeWidth="4" />
        <text x="40" y="54" fontSize="11">保守下包络（按来源着色）</text>
      </g>
    </svg>
  );
}

export { SOURCE_STYLE };

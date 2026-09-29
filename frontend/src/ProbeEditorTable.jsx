/** 单支探头的采样录入表，供双探头与三探头视图复用。 */

const MIN_ROWS = 2;

export const PROBE_LABELS = {
  probeA: '探头A',
  probeB: '探头B',
  probeC: '探头C',
};

export default function ProbeEditorTable({ probe, rows, errorRows, onChange, onAdd, onRemove }) {
  const name = PROBE_LABELS[probe];
  return (
    <div className="probe-editor">
      <h3>{name}</h3>
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
                  aria-label={`${name} 时间 第${index + 1}行`}
                  inputMode="numeric"
                  value={row.time}
                  onChange={(e) => onChange(probe, index, 'time', e.target.value)}
                />
              </td>
              <td>
                <input
                  aria-label={`${name} 温度 第${index + 1}行`}
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
                  aria-label={`${name} 删除 第${index + 1}行`}
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

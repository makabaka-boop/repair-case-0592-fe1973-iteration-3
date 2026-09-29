# 蒸汽杀菌致死量 F₀ 复核

常温乳品批次完成蒸汽杀菌后，质检员在此录入釜内探头的时间—温度采样，系统按梯形法积分复核致死量 F₀，达到 **3.00 min** 即放行。

## 业务规则

- 每个采样点的致死速率：`rate = 10^((T - 121.1) / 10)`（T 为 °C）。
- 相邻两点按梯形法积分：`段贡献 = (rate₁ + rate₂) / 2 × Δt秒 / 60`（分钟）。
- 各段以**未舍入**的值累加，最终 F₀ **四舍五入保留两位小数**；≥ 3.00 min 判定放行。
- 采样约束：至少 2 个点；时间从 0 秒起的整数秒且严格递增；相邻间隔 ≤ 60 秒；温度为 100.0–140.0 °C 的有限数。
- 任一行非法 → 整次请求失败（HTTP 422），响应指明行号与字段，前端同时清除旧结论。
- 不足量批次显示距门槛的差额；达标批次展示逐段贡献，可逐段复算放行值。

### 双探头保守复核

同一批次两支探头的采样时刻不完全一致时，质检员按**每一时刻较低的致死速率**形成保守结论，而不是简单取两份总 F₀ 的较小值。

- 两支探头各自从 0 秒开始、结束于**同一秒**，并分别遵守上述全部时间/温度/间隔校验（问题按探头 + 行号定位）。
- 后端取两组采样时刻的**并集**，在其上按原梯形法隐含的**分段线性**口径插值两条致死速率线。
- 若两条速率线在区间内部交换高低，则在**交点处拆段**后积分下包络；每个保守段返回来源探头（`probeA` / `probeB` / `both` 重合）、两探头各自速率与段贡献。
- 响应同时给出两探头各自总量与**保守总量**；放行只用**未舍入**的保守总量与 3.00 min 门槛比较（`conservativeF0` 仅为四舍五入展示口径）。
- 页面并列显示两支探头的速率曲线（含交点、按下包络来源着色）与保守段明细表，**表格与图形使用同一响应**。
- 双探头输入或请求失败只清除本次比较，不改写已经显示的单探头结论；原 `/api/lethality` 接口及其响应保持兼容。

### 三探头中位复核（可选第三支温度探头）

新增第三支探头后，质检员按**任一时刻三支探头致死速率的中位值**形成结论，而不是对三条探头各自的总 F₀ 取中位数——后者会掩盖单支探头在局部时间段内的异常。

- 三支探头各自从 0 秒开始、结束于**同一秒**，分别遵守上述全部时间/温度/间隔校验（问题按探头 + 行号定位，第三路为 `probeC`）。
- 后端取三组采样时刻的**并集（共同时间域）**，在其上按分段线性口径插值三条致死速率线；再收集**每一对**速率线在并集区间内部的交点作为切分点。三条直线的中位函数只在两线相交时换源，因此切分后每段的中位来源恒定，区间内梯形积分解析精确。
- 每个中位段返回来源探头（`probeA` / `probeB` / `probeC`）、并列中位集合 `tie`、段起点与终点速率由低到高的探头顺序 `startOrder`/`endOrder`、以及说明“为何由该探头贡献”的 `reason`（中段排序 + 并列裁决依据）。
- **固定裁决**（确定性、可复现）：
  - 交点重合（含三条线交于同一时刻）合并为同一个边界，不产生零时长片段；
  - 曲线重叠、并列中位按固定探头顺序 `probeA → probeB → probeC` 取最前者为来源，全部并列探头放入 `tie`；
  - 交点恰落在并集采样时刻上时不另拆零长度段。
- 响应同时给出三探头各自总量与**中位总量**；放行只用**未舍入**的中位总量与 3.00 min 门槛比较（`medianF0` 仅为四舍五入展示口径），不因展示舍入改变放行判断。
- 页面三路并列录入，图表的三条速率线、中位粗线与片段表使用**同一响应、同一组边界与来源探头**；每段悬停/明细都说明来源与并列裁决。
- 第三路缺样、时间域不相交（结束秒不一致）或数据非法时，**只拒绝本次分析**：页面保留上一份有效三探头报告，且不改写单/双探头结论；原 `/api/lethality` 与 `/api/lethality/dual` 的请求与响应语义保持兼容（双探头请求中多余的 `probeC` 字段被忽略，不升级为三探头分析）。

## 快速开始（Docker Compose）

```bash
docker compose up --build -d        # 启动 api + web
docker compose run --rm verify      # 一次性验收服务：黑盒检查全部通过则退出码为 0
```

浏览器打开 <http://localhost:8080>。Web 宿主端口可用环境变量覆盖：

```bash
WEB_PORT=9000 docker compose up --build -d   # 改为 http://localhost:9000
```

架构：`web`（nginx，伺服 React 构建产物并把 `/api` 同源代理到 `api`）→ `api`（FastAPI，致死量积分与校验）→ `verify`（一次性验收容器，跑完即退出）。

## 故障排查

- **web 一直不健康、verify 与首页无法启动**：旧版 `frontend/nginx.conf` 在 `proxy_pass` 中使用字面主机名，nginx 只在启动时解析一次 `api`；若此刻 `api` 尚未注册到 Docker 网络 DNS（启动顺序、容器重启、旧版 compose 忽略健康条件），nginx 会以 `host not found in upstream` 退出，web 容器随之不健康，依赖它的 verify 也被连锁阻塞。当前配置已改为 `resolver 127.0.0.11` + 变量式 `proxy_pass`，在请求时解析上游：nginx 不再因 `api` 未就绪而退出，`api` 恢复后 `/api` 自动可用，静态首页始终可访问。
- 查看健康检查失败原因：`docker compose ps` 后 `docker inspect --format '{{json .State.Health}}' <容器>`。
- 手动复跑验收：`docker compose run --rm verify`（verify 自身会等待服务就绪，最长 120 秒）。

## 测试

| 层 | 工具 | 运行 |
| --- | --- | --- |
| 计算边界 | pytest | `cd backend && pip install -r requirements-dev.txt && python -m pytest` |
| 录入交互 | Vitest | `cd frontend && npm ci && npm test` |
| 前后端联调 | Playwright | `docker compose up -d --build && cd frontend && npx playwright install chromium && npm run e2e` |

Playwright 也可整体容器化运行（无需本机装浏览器）：

```bash
docker compose --profile e2e run --rm e2e
```

联调测试默认打向 `http://localhost:8080`，可用 `BASE_URL` 或 `WEB_PORT` 环境变量覆盖。所有测试均走真实 HTTP 与真实计算，无固定结果或假接口。

## API

### `POST /api/lethality`

请求：

```json
{
  "points": [
    { "time": 0,   "temperature": 121.1 },
    { "time": 60,  "temperature": 121.1 },
    { "time": 120, "temperature": 121.1 },
    { "time": 180, "temperature": 121.1 }
  ]
}
```

达标响应（200）：

```json
{
  "f0": 3.0,
  "threshold": 3.0,
  "passed": true,
  "shortfall": null,
  "segments": [
    {
      "index": 1,
      "startTime": 0,
      "endTime": 60,
      "startTemperature": 121.1,
      "endTemperature": 121.1,
      "startRate": 1.0,
      "endRate": 1.0,
      "durationSeconds": 60,
      "contribution": 1.0
    }
  ]
}
```

校验失败响应（422，`row` 为 1-based 行号，`null` 表示整体问题）：

```json
{
  "detail": {
    "message": "采样数据校验失败，整次请求已拒绝",
    "errors": [
      { "row": 2, "field": "temperature", "message": "温度须在 100.0 至 140.0 °C 之间" }
    ]
  }
}
```

### `GET /api/health`

返回 `{"status": "ok"}`。

### `POST /api/lethality/dual`

双探头保守复核。请求体（两支探头各自携带 `points`，校验规则同上，问题多一个 `probe` 字段）：

```json
{
  "probeA": {
    "points": [
      { "time": 0, "temperature": 121.1 },
      { "time": 30, "temperature": 123.0 },
      { "time": 60, "temperature": 121.1 }
    ]
  },
  "probeB": {
    "points": [
      { "time": 0, "temperature": 123.0 },
      { "time": 60, "temperature": 123.0 }
    ]
  }
}
```

响应（200，节选）：

```json
{
  "threshold": 3.0,
  "probeA": { "probe": "probeA", "points": [{ "time": 0, "temperature": 121.1, "rate": 1.0 }],
              "totalUnrounded": 1.23, "f0": 1.23 },
  "probeB": { "...": "..." },
  "probeATotalUnrounded": 1.23,
  "probeBTotalUnrounded": 2.00,
  "conservativeUnrounded": 1.18,
  "conservativeF0": 1.18,
  "passed": false,
  "shortfall": 1.82,
  "segments": [
    {
      "index": 1,
      "startTime": 0.0, "endTime": 22.5, "durationSeconds": 22.5,
      "source": "probeA",
      "startRate": 1.0, "endRate": 1.6,
      "probeAStartRate": 1.0, "probeAEndRate": 1.6,
      "probeBStartRate": 1.5, "probeBEndRate": 1.6,
      "contribution": 0.4875
    }
  ]
}
```

- `source` 为 `probeA` / `probeB` / `both`（两线重合）；交点拆段后相邻段在交点处速率相等。
- 段 `startTime/endTime` 为交点时可以是小数秒（采样时刻本身仍是整数秒）。
- 跨探头整体问题（如两支探头结束秒不一致）：`{"row": null, "field": "probe", "probe": null, ...}`；单支探头的问题带 `"probe": "probeA" | "probeB"`。

### `POST /api/lethality/triple`

三探头逐刻中位复核。请求体在双探头基础上增加 `probeC`（校验规则同上，问题带 `"probe": "probeA" | "probeB" | "probeC"`）：

```json
{
  "probeA": { "points": [{ "time": 0, "temperature": 124.1 }] },
  "probeB": { "points": [{ "time": 0, "temperature": 121.1 }] },
  "probeC": { "points": [{ "time": 0, "temperature": 127.1 }] }
}
```

响应（200，节选）：

```json
{
  "threshold": 3.0,
  "probeA": { "probe": "probeA", "points": [{ "time": 0, "temperature": 124.1, "rate": 2.0 }],
              "totalUnrounded": 2.0, "f0": 2.0 },
  "probeB": { "...": "..." },
  "probeC": { "...": "..." },
  "probeATotalUnrounded": 2.0,
  "probeBTotalUnrounded": 2.5,
  "probeCTotalUnrounded": 2.5,
  "probeAF0": 2.0, "probeBF0": 2.5, "probeCF0": 2.5,
  "medianUnrounded": 2.08333,
  "medianF0": 2.08,
  "passed": false,
  "shortfall": 0.91667,
  "segments": [
    {
      "index": 1,
      "startTime": 0.0, "endTime": 20.0, "durationSeconds": 20.0,
      "source": "probeA",
      "tie": ["probeA"],
      "startOrder": ["probeB", "probeA", "probeC"],
      "endOrder": ["probeA", "probeB", "probeC"],
      "reason": "中段速率由低到高：探头B < 探头A < 探头C；中位曲线为探头A",
      "startRate": 2.0, "endRate": 2.0,
      "probeAStartRate": 2.0, "probeAEndRate": 2.0,
      "probeBStartRate": 1.0, "probeBEndRate": 2.0,
      "probeCStartRate": 4.0, "probeCEndRate": 3.5,
      "contribution": 0.66667
    }
  ]
}
```

- `source` 为本段中位曲线来源；当多支探头并列中位时，`tie` 列出全部并列探头（含 `source`），来源按固定顺序 A→B→C 裁决，`reason` 说明中段排序与裁决依据。
- 段 `startTime/endTime` 在交点处可为小数秒；采样时刻本身仍是整数秒。所有 `durationSeconds > 0`，片段首尾相接铺满共同时间域。
- 第三路缺样（无 `probeC` 或其数据非法）、三支探头结束秒不一致、非法 JSON/字段均返回 422，响应不含 `medianUnrounded`/`segments`；跨探头整体问题为 `{"row": null, "field": "probe", "probe": null, ...}`。

## 本地开发

```bash
cd backend && pip install -r requirements-dev.txt
uvicorn app.main:app --reload          # http://localhost:8000

cd frontend && npm ci && npm run dev   # http://localhost:5173（/api 已代理到 8000）
```

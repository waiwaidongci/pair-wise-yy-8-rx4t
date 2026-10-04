# 古法纸浆发酵记录

浸泡缸、纸浆批次、观察记录接成的入缸账。

运行：

```bash
npm start
```

访问`http://localhost:3039`。数据保存在`data/paper-pulp-fermentation.json`。

## 入账规则

- **观察凭现场单号入账**：每条观察必须带现场单号（`slipNo`），同一单号重复补传以首次记录为准，不重复追加。
- **乱序补录按日期重算**：夜班、白班补录到齐后，观察按日期排序；发酵天数 = 不同观察日期数，状态与异常以最新日期的记录为准。
- **缸位占用**：批次出缸（可抄纸）且换水全部确认前，缸位不分给下一批；新批次分到占用缸会返回 `409 vat_occupied`。换水确认走 `POST /api/items/:id/confirm-water`，重复确认不重复入账。
- **保存与恢复**：写库先写临时文件、留 `.bak` 备份再原子改名；主文件损坏时自动从最后确认的 `.bak` 恢复。保存失败重试凭单号幂等，不会重复追加。
- **并发**：所有写操作串行落账；请求可带 `baseVersion`，两人同时提交同一批次时先到确认生效，后到者收到 `409 version_conflict`，刷新后重试。
- **旧数据升级**：启动时自动把旧记录升级到新版账本，补齐现场单号（`LEGACY-*`）、来源（`旧数据补齐`）和入缸日期，原有记录照常打开。

## 接口

- `GET /api/items` / `GET /api/items/:id` — 批次列表 / 单条记录
- `POST /api/items` — 新增批次（编号唯一，缸位占用校验）
- `POST /api/items/:id/action` — 提交观察（`slipNo`、`date`、`shift`、`temperature`、`smell`、`fiber`、`changedWater`、`abnormal`，可带 `baseVersion`）
- `POST /api/items/:id/confirm-water` — 确认换水，满足条件后释放缸位
- `PATCH /api/items/:id` — 修改状态等字段（可带 `baseVersion`）
- `POST /api/items/:id/logs` — 追加备注
- `GET /api/vats` — 缸位占用总览
- `GET /api/stats` — 状态统计

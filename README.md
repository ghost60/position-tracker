# Binance 多账户持仓跟踪器

这是从 Wangcai Dashboard 中独立出来的合约持仓变化跟踪项目。它不依赖原看板的 `server.js`，可以单独复制、配置和运行。

功能：

- 一个进程配置多个 Binance 主账户 API Key。
- 每个主账户配置多个子账户，也可自动发现该主账户下的全部子账户。
- 跟踪 USD-M / COIN-M 合约非零仓位，按固定间隔与本地基线比较。
- 按发生变化的子账户分别发送 Webhook，消息包含跟踪账户名称和子账户名称。
- 支持 HMAC-SHA256 签名、超时和指数退避重试。
- Binance 任一已配置范围拉取失败时不推进基线，避免把接口故障误报成清仓。

## 运行要求

- Node.js 18 或更高版本。
- 主账户 API Key 需要读取子账户列表和子账户合约仓位的权限。
- 如果配置主账户本身的合约仓位，API Key 还需要对应 USD-M / COIN-M 读取权限。
- 建议只授予读取权限，不需要提现权限。

## 快速开始

在本目录执行：

```powershell
Copy-Item .env.example .env
Copy-Item config\accounts.example.json config\accounts.json
```

编辑 `config/accounts.json`，配置账户名称和子账户；再编辑 `.env`，填写 JSON 中引用的环境变量。不要把真实 API Key 或 Secret 写进 `accounts.json`。

检查一次：

```powershell
npm test
npm run scan
```

持续运行：

```powershell
npm start
```

第一次成功扫描只建立 `data/position-baseline.json`，不会把现有仓位误报为新开仓。后续扫描检测到变化才会追加 `data/position-changes.jsonl` 并发送 Webhook。

## 多账户配置

`config/accounts.json` 的核心结构：

```json
{
  "accounts": [
    {
      "id": "strategy-a",
      "name": "策略账户 A",
      "apiKeyEnv": "BINANCE_STRATEGY_A_API_KEY",
      "apiSecretEnv": "BINANCE_STRATEGY_A_API_SECRET",
      "discoverSubAccounts": false,
      "subAccounts": [
        {
          "id": "strategy-a-sub-1",
          "name": "一号子账户",
          "type": "sub",
          "email": "sub-1@example.com",
          "markets": ["usdm", "coinm"]
        }
      ]
    }
  ]
}
```

字段说明：

- `id`：稳定唯一标识，只允许字母、数字、下划线和连字符。修改 id 会被视为新的跟踪范围。
- `name`：Webhook 中展示的账户名称。
- `apiKeyEnv` / `apiSecretEnv`：保存凭据的环境变量名，不是凭据本身。
- `subAccounts`：该 API 主账户下需要跟踪的范围。
- `type: "sub"`：子账户，必须配置 `email`。
- `type: "master"`：跟踪 API Key 所属主账户本身，不配置 `email`。
- `markets`：可选 `usdm`、`coinm`；默认两者都跟踪。
- `discoverSubAccounts: true`：调用 Binance 子账户列表接口，自动加入未显式配置的子账户。
- `discoveredSubAccountMarkets`：自动发现的子账户要跟踪的市场，默认 `usdm` 和 `coinm`。

显式配置的子账户优先，因此可以为特定邮箱指定友好的名称和不同市场。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `TRACKER_ACCOUNTS_FILE` | `config/accounts.json` | 账户 JSON 路径 |
| `TRACKER_DATA_DIR` | `data` | 基线与记录目录 |
| `POSITION_SCAN_INTERVAL_MS` | `300000` | 扫描间隔，毫秒 |
| `BINANCE_RECV_WINDOW` | `5000` | Binance 签名接收窗口 |
| `BINANCE_SIGNED_REQUEST_RETRIES` | `2` | 时间戳错误校时重试次数 |
| `FETCH_TIMEOUT_MS` | `15000` | Binance/Webhook 超时，毫秒 |
| `WEBHOOK_ENABLED` | `true` | Webhook 总开关 |
| `WEBHOOK_URL` | 空 | 接收地址；空值时只落本地记录 |
| `WEBHOOK_SECRET` | 空 | HMAC-SHA256 密钥；空值时不签名 |
| `WEBHOOK_SIGNATURE_HEADER` | `X-Signature-256` | 签名请求头名称 |
| `WEBHOOK_SIGNATURE_TEMPLATE` | `sha256=<hex>` | 签名值格式 |
| `WEBHOOK_MAX_ATTEMPTS` | `5` | 最大投递次数 |
| `WEBHOOK_BACKOFF_MS` | `1000` | 首次重试等待时间，之后翻倍 |

每个账户的 API Key/Secret 环境变量名称由 `accounts.json` 自行指定，因此账户数量没有固定上限。

## Webhook 消息

每个发生变化的子账户发送一条消息：

```json
{
  "event": "position_change",
  "recordId": "1787875500000-a1b2c3d4",
  "generatedAt": "2026-08-28T00:05:00.000Z",
  "trackingAccount": {
    "id": "strategy-a",
    "name": "策略账户 A"
  },
  "subAccount": {
    "id": "strategy-a-sub-1",
    "name": "一号子账户",
    "type": "sub",
    "email": "sub-1@example.com"
  },
  "account": {
    "name": "策略账户 A",
    "email": "sub-1@example.com",
    "remark": "一号子账户"
  },
  "changes": [
    {
      "venue": "USD-M Futures",
      "symbol": "BTCUSDT",
      "baseAsset": "BTC",
      "positionSide": "BOTH",
      "deltaQuantity": "1",
      "targetQuantity": "2",
      "action": "increase_long"
    }
  ]
}
```

`account` 是兼容原 Wangcai Webhook 消费端的字段；新程序建议读取语义更明确的 `trackingAccount` 和 `subAccount`。

签名默认是：

```text
X-Signature-256: sha256=<hex(HMAC-SHA256(WEBHOOK_SECRET, 原始请求 body))>
```

Webhook 不包含价格。数量均为字符串；`deltaQuantity` 是本次增量，`targetQuantity` 是变化后的目标仓位。

## Linux / PM2 部署

```bash
cd /path/to/position-tracker
pm2 start npm --name binance-position-tracker -- start
pm2 logs binance-position-tracker
```

配置变更后重启进程。请确保 `.env`、`config/accounts.json` 和 `data/` 不进入版本控制或公开制品。

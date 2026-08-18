# Telegram 群组入群验证机器人

这是一个运行在 Cloudflare Workers 免费版上的 Telegram 群组验证机器人。新成员入群后会立即被禁言，随机完成四选一验证题后恢复群组默认权限；答错或超时会被移出并进入冷却期，验证成功后自动发送欢迎语和链接菜单。

## 功能

- 监听新成员加入
- 自动禁言
- 随机四种题型：加减法、找最大数、数图形和简单数列
- 防止其他成员代答
- 超时自动移出
- 只有一次选择机会，答错立即移出
- 首次点击后立即锁定按钮，避免连续试错
- 答案仅保存在服务端状态，回调不携带原始答案
- 失败后临时禁止重新入群
- 验证成功恢复群组默认权限
- 自定义欢迎语和最多8个链接按钮
- 自动删除验证消息
- Webhook Secret 校验和更新去重

## 部署

### 1. 创建 Worker

在 Cloudflare 创建 `telegram-group-verification-bot`，将 [`src/index.js`](../src/index.js) 粘贴到代码编辑器并部署。

### 2. 创建 KV

创建 Workers KV 命名空间并绑定为：

```text
BOT_DATA
```

### 3. 添加 Secret

```text
BOT_TOKEN
WEBHOOK_SECRET
```

### 4. 添加变量

```text
GROUP_CHAT_ID=0
GROUP_NAME=你的群名称
GROUP_URL=https://t.me/your_group
VERIFY_TIMEOUT_MINUTES=2
REJOIN_COOLDOWN_MINUTES=30
```

可选按钮变量：

```text
CHANNEL_URL
YOUTUBE_URL
FORUM_URL
WEBSITE_URL
X_URL
BLOG_URL
NAV_URL
STORE_URL
```

没有填写的链接不会显示。每个URL还可以用对应的 `*_LABEL` 变量修改按钮文字。

### 5. 添加Cron

在Worker触发器中添加：

```text
* * * * *
```

用于每分钟清理超时验证。

### 6. 设置Webhook

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\tools\setup-webhook.ps1
```

### 7. 获取群ID

先设置 `GROUP_CHAT_ID=0`，部署并设置Webhook，然后管理员在群里发送：

```text
/chatid
```

把机器人返回的负数填写回 `GROUP_CHAT_ID` 并重新部署。

## 机器人权限

只需要：

- 删除消息
- 封禁/限制用户

不要同时运行多个入群验证机器人。

## 防护范围

增强验证适合拦截通用入群脚本、盲点按钮和低成本广告账号，不需要额外网页。它不能保证阻止专门使用OCR或AI识别题目的UserBot。高风险群组仍建议进一步使用“入群申请＋一次性签名链接＋Cloudflare Turnstile”。

## 许可证

[MIT](../LICENSE)

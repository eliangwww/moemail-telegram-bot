# 基于 Deno 的 Moemail Telegram Bot

这是一个基于 [Moemail](https://github.com/beilunyang/moemail) 的现代化 Telegram 机器人，采用 Deno 和 Deno Deploy 构建，提供完整的临时邮箱管理、实时邮件通知、网页查看和 AI 验证码提取功能。

## ✨ 功能特性

### 📧 **临时邮箱管理**
* **交互式创建**: 通过内联键盘按钮引导用户创建邮箱，支持：
  * 🎲 随机前缀或 ✏️ 自定义前缀
  * ⏰ 灵活有效期选择（1小时/1天/3天/永久）
  * 🌐 多域名支持（通过环境变量配置）
* **邮箱管理**: 查看、删除已创建的临时邮箱
* **邮件查看**: 支持 Telegram 内预览和完整网页查看

### 🔔 **实时通知系统**
* **即时推送**: 新邮件到达时立即通过 Telegram 通知
* **双重查看**: 提供 Telegram 命令查看和网页直接查看链接
* **智能预览**: 显示邮件主题、发件人、时间和内容预览

### 🌐 **网页邮件查看**
* **完整显示**: 支持 HTML 和纯文本邮件完整渲染
* **响应式设计**: 适配手机和桌面浏览器
* **安全访问**: 基于用户 ID 和 API Key 的权限验证

### 🤖 **AI 智能功能**
* **验证码提取**: 自动从邮件中识别和提取验证码
* **多模型支持**: 支持 OpenAI 和兼容 API（默认智谱 GLM）

### 🔧 **开发者友好**
* **Bitwarden 集成**: 兼容 Addy.io API，支持密码管理器直接生成临时邮箱
* **简洁代码**: 精简优化的代码结构，易于维护和扩展

## 先决条件

在部署之前，请确保您已准备好以下各项：

1.  **Deno**: 确保您的本地开发环境或部署环境支持 Deno (推荐最新稳定版)。对于 Deno Deploy，平台本身已内置 Deno 运行时。
2.  **Deno Deploy 账户**: 您需要一个 [Deno Deploy](https://deno.com/deploy) 账户来托管此应用。
3.  **Telegram Bot Token**:
    * 通过与 Telegram 上的 [@BotFather](https://t.me/BotFather) 对话来创建一个新的机器人并获取其 Token。
4.  **API Key**:
    * 您需要部署一个 [Moemail](https://github.com/beilunyang/moemail)，并生成 Moemail 的 API Key，以便机器人能够通过其 API 管理临时邮箱。用户将通过 `/key` 命令在机器人中设置自己的 API Key。
5.  **OpenAI API Key (可选)**:
    * 如果您希望使用 AI 提取验证码的功能，您需要一个 OpenAI API Key (或兼容 OpenAI API 格式的服务商提供的 Key)。

## ⚙️ 环境变量配置

在 Deno Deploy 项目的设置中，您需要配置以下环境变量：

### 必需变量
* `TELEGRAM_BOT_TOKEN`: 您的 Telegram 机器人 Token
* `DENO_DEPLOY_BASE_URL`: 您的 Deno Deploy 应用 URL（如 `https://your-project.deno.dev`）

### 可选变量
* `OPENAI_API_KEY`: OpenAI API Key（启用 AI 验证码提取功能）
* `OPENAI_API_BASE_URL`: OpenAI API 基础 URL（默认：`https://api.openai.com/v1`）
* `OPENAI_MODEL`: AI 模型名称（默认：`gpt-3.5-turbo`）
* `UNSEND_API_BASE_URL`: Moemail API 基础 URL（默认：`https://unsend.de/api`）
* `DOMAINS`: 可用邮箱域名（默认：`unsend.de`，多个域名用 `|` 分隔，如：`domain1.com|domain2.org`）

### 智谱 AI 配置示例
如需使用免费的智谱 AI 服务：
```
OPENAI_API_BASE_URL=https://open.bigmodel.cn/api/paas/v4
OPENAI_MODEL=glm-4-flash
```
API Key 获取地址：https://bigmodel.cn

### 自建 Moemail 实例
建议部署自己的 Moemail 实例并相应配置 `UNSEND_API_BASE_URL` 和 `DOMAINS`。
部署教程：https://github.com/beilunyang/moemail

## 部署步骤

1.  **准备代码**:
    * 复制 `main.ts` 中的代码。

2.  **创建 Deno Deploy 项目**:
    * 登录到您的 [Deno Deploy](https://deno.com/deploy) 控制台。
    * 创建一个新项目。选择 "Playground"，粘贴代码。

4.  **设置环境变量**:
    * 在 Deno Deploy 项目的 "Settings" -> "Environment Variables" 部分，添加上面列出的环境变量及其对应的值。

5.  **部署**:
    * Deno Deploy 通常会在您提交代码或保存 Playground 后自动部署。
    * 等待部署完成。您可以在 Deno Deploy 控制台查看部署日志。

6.  **设置 Telegram Bot Webhook**:
    * 机器人启动后，会在日志中打印出需要设置的 Telegram Webhook URL。该 URL 的格式为：`https://<您的Deno_Deploy应用URL>/telegram-webhook`。
    * 例如，如果您的 Deno Deploy 应用 URL 是 `https://my-tempmail-bot.deno.dev`，那么 Webhook URL 就是 `https://my-tempmail-bot.deno.dev/telegram-webhook`。
    * 使用以下 `curl` 命令或通过浏览器访问来设置 Webhook (将 `<YOUR_BOT_TOKEN>` 和 `<YOUR_DEPLOYMENT_URL>` 替换为您的实际值)：
        ```bash
        curl -F "url=https://<YOUR_DEPLOYMENT_URL>/telegram-webhook" https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook
        ```
        ```
        或者直接访问： https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_DEPLOYMENT_URL>/telegram-webhook
        ```
    * 您应该会收到一个 JSON 响应，其中 `ok` 为 `true`，表示 Webhook 设置成功。

## 📱 如何使用机器人

### 基础命令
* `/start` 或 `/help`: 显示帮助信息和可用命令列表
* `/key <API_Key>`: 设置您的 Moemail API Key（必需）

### 邮箱管理
* `/list`: 查看可用的邮箱域名
* `/add`: **交互式创建临时邮箱**（推荐）
  * 🎯 **第1步**: 选择前缀类型
    * 🎲 随机前缀 - 系统自动生成
    * ✏️ 自定义前缀 - 输入您想要的前缀
  * 🕐 **第2步**: 选择有效期
    * ⏰ 1小时 / 📅 1天 / 📅 3天 / ♾️ 永久
  * 🌐 **第3步**: 选择域名
    * 从配置的可用域名中选择
  * ✅ **第4步**: 确认创建
* `/box [cursor]`: 查看您创建的所有临时邮箱（支持分页）
* `/del <emailId>`: 删除指定的临时邮箱
* `/cancel`: 取消当前的邮箱创建流程

### 邮件查看
* `/mail <emailId> [cursor]`: 查看指定邮箱内的邮件列表（支持分页）
* `/view <emailId> <messageId>`: 查看邮件详情
  * 📱 Telegram 内预览（纯文本）
  * 🌐 网页完整查看（HTML + 纯文本）
  * 🤖 AI 自动提取验证码（如已启用）

### 使用示例
```
1. 发送 /key your_api_key_here
2. 发送 /add
3. 点击 [🎲 随机前缀]
4. 点击 [📅 1天]
5. 点击 [unsend.de]
6. 点击 [✅ 确认创建]
```

## 🔔 邮件通知配置

### Webhook 设置
1. 向机器人发送 `/start` 或 `/help` 命令获取您的专属 Webhook URL
2. URL 格式：`https://your-app.deno.dev/your_telegram_user_id`
3. 在 Moemail 账户设置中配置此 Webhook URL

### 通知功能
配置完成后，新邮件到达时您将收到包含以下信息的 Telegram 通知：
* 📧 邮件基本信息（发件人、主题、时间）
* 📝 内容预览（前250字符）
* 🤖 AI 提取的验证码（如已启用）
* 📱 Telegram 查看命令：`/view emailId messageId`
* 🌐 网页直接查看链接

## 🔧 Bitwarden 集成

支持通过 Bitwarden 密码管理器直接生成临时邮箱：

### 配置步骤
1. **Bitwarden 设置**：
   * 生成器 → 用户名 → 转发的电子邮箱别名
   * 服务：选择 `Addy.io`
   * 电子邮箱域名：填入您的域名（如 `unsend.de`）
   * API 密钥：填入您的 Moemail API Key
   * 自托管服务 URL：`https://your-app.deno.dev`

2. **使用方法**：
   * 点击随机生成按钮即可创建1天有效期的临时邮箱
   * 邮箱收到邮件后可在 Moemail 网页查看
   * 如配置了 Telegram 通知，将同时推送到您的 Telegram

### 配置示例
![Bitwarden 配置示例](https://e4.jpgcdn.com/2025/05/10/sqgZ.png)

## 🔧 故障排除

### 常见问题
* **环境变量检查**: 确保所有必需的环境变量已正确设置，无多余空格
* **Webhook 配置**: 确认 Telegram Webhook URL 正确设置为 `https://your-app.deno.dev/telegram-webhook`
* **API Key 验证**: 确保 Moemail 和 OpenAI API Key 有效且具有所需权限
* **域名配置**: 检查 `DOMAINS` 环境变量格式是否正确

### 调试方法
1. **查看日志**: Deno Deploy 控制台 → 项目 → Logs
2. **测试 Webhook**: 使用 curl 测试 Telegram Webhook 是否正常
3. **验证 API**: 直接调用 Moemail API 确认连接正常

### 功能特性对比

| 功能 | 描述 | 状态 |
|------|------|------|
| 🎯 交互式邮箱创建 | 内联键盘按钮引导 | ✅ |
| 📱 Telegram 邮件预览 | 纯文本内容预览 | ✅ |
| 🌐 网页完整查看 | HTML + 纯文本渲染 | ✅ |
| 🤖 AI 验证码提取 | 智能识别验证码 | ✅ |
| 🔔 实时邮件通知 | Webhook 推送 | ✅ |
| 🔧 Bitwarden 集成 | Addy.io 兼容 API | ✅ |
| 🌍 多域名支持 | 环境变量配置 | ✅ |

---

## 📄 更新日志

- **v2.0** - 重大更新
  - ✨ 新增交互式邮箱创建（内联键盘）
  - 🌐 新增网页邮件查看功能
  - 🎯 优化用户体验和代码结构
  - 📱 改进命令分离（`/box` 和 `/mail`）
- **v1.1** - 功能增强
  - 🔧 新增 Bitwarden 集成
  - 🤖 新增 AI 验证码提取
- **v1.0** - 初始版本
  - 📧 基础临时邮箱管理
  - 🔔 邮件通知功能

---

**祝您使用愉快！** 🎉

如有问题或建议，欢迎提交 Issue 或 Pull Request。
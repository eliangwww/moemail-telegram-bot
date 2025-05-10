# 基于 Deno 的 Moemail Telegram bot

这是一个 [Moemail](https://github.com/beilunyang/moemail) 的增强型 Telegram 机器人，基于 Deno 和 Deno Deploy，它提供了临时邮箱管理、邮件通知以及通过 AI 提取邮件验证码的功能。

## 功能特性

* **邮件通知 Webhook**: 当您的临时邮箱收到新邮件时，通过 Telegram 机器人实时通知您。
* **临时邮箱管理**:
    * 设置和管理 API Key。
    * 查看提供的可用邮箱域名。
    * 创建自定义前缀、有效期和域名的临时邮箱。
    * 一键创建随机前缀、默认域名和1天有效期的临时邮箱。
    * 查看您已创建的临时邮箱列表 (支持分页)。
    * 查看指定邮箱内的邮件列表 (支持分页)。
    * 查看单封邮件的详细内容。
    * 删除指定的临时邮箱。
* **AI 验证码提取**:
    * (可选) 在收到新邮件通知或查看邮件详情时，自动尝试从邮件主题和内容中提取验证码。

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

## 环境变量配置

在 Deno Deploy 项目的设置中，您需要配置以下环境变量：

* `TELEGRAM_BOT_TOKEN` (必需): 您的 Telegram 机器人 Token。
* `OPENAI_API_KEY` (可选): 您的 OpenAI API Key。如果未设置，AI 提取验证码功能将禁用。

以下内容请直接在 main.ts 修改：

* `OPENAI_API_BASE_URL` (可选): OpenAI API 的基础 URL。默认为 `https://open.bigmodel.cn/api/paas/v4`。如果您的 API 服务商使用不同的 URL，请设置此项。
* `OPENAI_MODEL`(可选): 模型。默认为 `glm-4-flash-250414`。如果您想使用不同的模型，请设置此项。
* `UNSEND_API_BASE_URL` (可选): Moemail API 的基础 URL。默认为 `https://unsend.de/api`。
* `DENO_DEPLOY_URL` (可选): 您的 Deno Deploy 应用的公开访问 URL (例如 `https://your-project-name.deno.dev`)。如果未设置，代码中默认为 `https://unsend.deno.dev`，但建议您根据实际部署情况进行设置，以便机器人能正确生成 Webhook URL。

**建议全局替换 `unsend.de` 为您部署的 Moemail 实例**。Moemail 部署方法请参照其仓库中的教程： https://github.com/beilunyang/moemail 。

这里默认使用智谱的 API ，原因为 `glm-4-flash-250414` 为免费模型，注册即可使用，API Key 获取地址为： https://bigmodel.cn 。

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

## 如何使用机器人

与您的 Telegram 机器人开始对话后，您可以使用以下命令：

* `/start` 或 `/help`: 显示帮助信息和可用命令列表。
* `/key <您的_unsend.de_API_Key>`: 设置或更新您在 Moemail 的 API Key。这是使用邮箱管理功能的前提。
* `/list`: 查看 Moemail 提供的可用邮箱域名。
* `/add [名称] [有效期] [域名]`: 创建一个新的临时邮箱。
    * 如果**不带任何参数** (`/add`)，机器人会自动创建一个随机6位字符前缀、使用设置的域名、有效期为1天的临时邮箱。
    * **参数说明**:
        * `名称`: (可选) 您希望的邮箱前缀 (例如 `mytest`)。
        * `有效期`: (可选) 邮箱的有效时间。可选值: `1h` (1小时), `1d` (1天), `7d` (7天), `perm` (永久)。
        * `域名`: (可选) 邮箱的域名 (例如 `moemail.app`)。可从 `/list` 命令获取。
    * **示例**: `/add mytempmail 7d moemail.app`
* `/mails`: 列出您通过此机器人创建的所有临时邮箱。
* `/mail <emailId> [cursor]`: 列出指定 `emailId` 邮箱内的邮件标题。可选 `cursor` 用于分页。
* `/view <emailId> <messageId>`: 查看指定邮箱 (`emailId`) 中特定邮件 (`messageId`) 的详细内容。如果 AI 功能已启用，还会尝试提取验证码。
* `/del <emailId>`: 删除指定的临时邮箱。

## 邮件通知 Webhook 配置

要接收新邮件的 Telegram 通知，您需要将机器人提供的专属 Webhook URL 配置到您的 Moemail 账户设置中。

1.  向您的机器人发送 `/start` 或 `/help` 命令。
2.  机器人会回复您的专属 Webhook URL，格式为：`https://<您的Deno_Deploy应用URL>/<您的Telegram用户ID>`。
3.  登录到您的 Moemail 账户。
4.  找到 Webhook 配置部分 (通常在个人资料或设置页面)。
5.  将机器人提供的 URL 填入。

配置完成后，当您的 Moemail 临时邮箱收到新邮件时，该服务会向您的机器人部署地址发送一个 POST 请求，机器人解析后会通过 Telegram 通知您，并追加一条 `/view` 命令方便您查看完整邮件。

## 故障排除

* **检查 Deno Deploy 日志**: 如果遇到问题，首先查看 Deno Deploy 项目的实时日志，通常能提供有用的错误信息。
* **确认环境变量**: 确保所有必需的环境变量都已正确设置，并且没有多余的空格或特殊字符。
* **Telegram Webhook**: 确认 Telegram Webhook URL 设置正确，并且与代码中 `TELEGRAM_WEBHOOK_PATH` (固定为 `/telegram-webhook`) 匹配。
* **API Key 有效性**: 确保您提供的 Moemail API Key 和 (可选的) OpenAI API Key 是有效的并且具有所需权限。

祝您使用愉快！
// main.ts
// Deno Deploy 上的 Telegram 邮件 Webhook 机器人
// 功能: 邮件通知, AI提取验证码, 临时邮箱管理 (创建、查看、列出、删除), 查看单封邮件, 查看邮箱内邮件列表
// Telegram Webhook 固定路径为 '/telegram-webhook'

import {
    serve,
    type ConnInfo,
} from "https://deno.land/std@0.224.0/http/server.ts";
import {
    Bot,
    webhookCallback,
    GrammyError,
    HttpError,
} from "https://deno.land/x/grammy@v1.22.4/mod.ts";

// --- 环境变量 ---
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const DENO_DEPLOY_BASE_URL =
    Deno.env.get("DENO_DEPLOY_URL") || "https://unsend.deno.dev";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_API_BASE_URL =
    Deno.env.get("OPENAI_API_BASE_URL") || "https://open.bigmodel.cn/api/paas/v4";
const OPENAI_MODEL = "glm-4-flash-250414";

const UNSEND_API_BASE_URL =
    Deno.env.get("UNSEND_API_BASE_URL") || "https://unsend.de/api";

// Telegram Webhook 路径固定
const TELEGRAM_WEBHOOK_PATH = "/telegram-webhook";

if (!BOT_TOKEN) {
    console.error("致命错误: TELEGRAM_BOT_TOKEN 环境变量未设置!");
    throw new Error("TELEGRAM_BOT_TOKEN 环境变量未设置!");
}

// --- Deno KV 初始化 ---
let kv: Deno.Kv | null = null;
try {
    kv = await Deno.openKv();
    console.log("[KV] Deno KV store opened successfully.");
} catch (error) {
    console.error("[KV] Failed to open Deno KV store:", error);
}


// --- Bot 初始化 ---
const bot = new Bot(BOT_TOKEN);

// --- Deno KV 辅助函数 (用于存储用户 unsend.de API Key) ---
async function saveUserUnsendApiKey(userId: number, apiKey: string): Promise<boolean> {
    if (!kv) {
        console.error("[KV] KV store not available. Cannot save API key.");
        return false;
    }
    try {
        await kv.set(["unsend_api_keys", userId.toString()], apiKey);
        console.log(`[KV] Successfully saved Unsend API key for user ${userId}.`);
        return true;
    } catch (error) {
        console.error(`[KV] Error saving Unsend API key for user ${userId}:`, error);
        return false;
    }
}

async function getUserUnsendApiKey(userId: number): Promise<string | null> {
    if (!kv) {
        console.error("[KV] KV store not available. Cannot retrieve API key.");
        return null;
    }
    try {
        const result = await kv.get<string>(["unsend_api_keys", userId.toString()]);
        return result.value;
    } catch (error) {
        console.error(`[KV] Error retrieving Unsend API key for user ${userId}:`, error);
        return null;
    }
}

// --- Unsend.de API 客户端辅助函数 ---
interface UnsendApiResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
    statusCode?: number;
}

async function fetchUnsendApi<T>(
    userApiKey: string,
    endpoint: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    body?: Record<string, any>
): Promise<UnsendApiResponse<T>> {
    const url = `${UNSEND_API_BASE_URL}${endpoint}`;
    const options: RequestInit = {
        method,
        headers: {
            "X-API-Key": userApiKey,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    };
    if (body && (method === "POST")) {
        options.body = JSON.stringify(body);
    }

    try {
        console.log(`[UnsendAPI] 请求中: ${method} ${url}`);
        const response = await fetch(url, options);
        if (!response.ok) {
            const errorText = await response.text();
            console.error(
                `[UnsendAPI] API 请求到 ${endpoint} 失败，状态码 ${response.status}: ${errorText}`
            );
            return {
                success: false,
                error: `API 错误: ${response.status} - ${errorText || response.statusText}`,
                statusCode: response.status,
            };
        }
        if (response.status === 204) {
            return { success: true, data: undefined, statusCode: response.status };
        }
        const responseData = await response.json();
        return { success: true, data: responseData as T, statusCode: response.status };
    } catch (error) {
        console.error(`[UnsendAPI] 调用 ${endpoint} 时发生网络或其他错误:`, error);
        return { success: false, error: error.message || "网络错误" };
    }
}

// 获取可用域名
async function getAvailableDomains(userApiKey: string): Promise<UnsendApiResponse<string[]>> {
    const response = await fetchUnsendApi<any>(userApiKey, "/emails/domains");
    if (response.success && response.data) {
        if (Array.isArray(response.data)) {
            return { success: true, data: response.data as string[] };
        } else if (response.data.domains && Array.isArray(response.data.domains)) {
             return { success: true, data: response.data.domains as string[] };
        } else {
            console.warn("[UnsendAPI] getAvailableDomains: 返回的数据结构未知:", response.data);
            return { success: false, error: "获取域名时返回了未知的数据结构。"};
        }
    }
    return response;
}

// 生成临时邮箱
interface GenerateEmailPayload {
    name?: string;
    expiryTime: number;
    domain: string;
}
interface GeneratedEmail {
    id: string;
    email: string;
    expiresAt?: string;
    createdAt?: string;
}
async function generateTempEmail(userApiKey: string, payload: GenerateEmailPayload): Promise<UnsendApiResponse<GeneratedEmail>> {
    return fetchUnsendApi<GeneratedEmail>(userApiKey, "/emails/generate", "POST", payload);
}

// 获取用户创建的所有邮箱列表
interface EmailListItem {
    id: string;
    address: string;
    email?: string;
    expiresAt: string;
    createdAt: string;
}
interface EmailListResponse {
    emails: EmailListItem[];
    nextCursor: string | null;
    total?: number;
}
async function listUserEmails(userApiKey: string, cursor?: string): Promise<UnsendApiResponse<EmailListResponse>> {
    const endpoint = cursor ? `/emails?cursor=${encodeURIComponent(cursor)}` : "/emails";
    return fetchUnsendApi<EmailListResponse>(userApiKey, endpoint);
}

// 获取指定邮箱内的邮件列表
interface MailboxMessageItem {
    id: string; // messageId
    from_address?: string;
    subject?: string;
    received_at: number;
}
interface MailboxMessagesResponse {
    messages: MailboxMessageItem[];
    nextCursor: string | null;
    total?: number;
}
async function getEmailsInMailbox(userApiKey: string, emailId: string, cursor?: string): Promise<UnsendApiResponse<MailboxMessagesResponse>> {
    const endpoint = `/emails/${emailId}${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`;
    return fetchUnsendApi<MailboxMessagesResponse>(userApiKey, endpoint);
}


// 获取单封邮件内容
interface SingleEmailData {
    id: string;
    from_address?: string;
    subject?: string;
    content?: string;
    html?: string;
    received_at: number;
}
interface SingleEmailApiResponse {
    message: SingleEmailData;
}
async function getSingleEmailMessage(userApiKey: string, emailId: string, messageId: string): Promise<UnsendApiResponse<SingleEmailData>> {
    const response = await fetchUnsendApi<SingleEmailApiResponse>(userApiKey, `/emails/${emailId}/${messageId}`);
    if (response.success && response.data && response.data.message) {
        return { success: true, data: response.data.message, statusCode: response.statusCode };
    } else if (response.success && !response.data?.message) {
        return { success: false, error: "API返回数据结构不符合预期 (缺少 'message' 对象)", statusCode: response.statusCode };
    }
    return { success: response.success, error: response.error, statusCode: response.statusCode };
}

// 删除临时邮箱
async function deleteTempEmail(userApiKey: string, emailId: string): Promise<UnsendApiResponse<null>> {
    return fetchUnsendApi<null>(userApiKey, `/emails/${emailId}`, "DELETE");
}


// --- 辅助函数：使用 OpenAI API 提取验证码 (已存在) ---
interface VerificationCodeInfo { type: "code" | "none"; value: string | null; }
async function extractVerificationCode(emailSubject: string, emailText: string): Promise<VerificationCodeInfo> {
    if (!OPENAI_API_KEY) { return { type: "none", value: null }; }
    const truncatedSubject = (emailSubject || "").substring(0, 200);
    const truncatedText = (emailText || "").substring(0, 6000);
    const prompt = `你是一个专门从邮件内容中提取注册验证码的专家助手。\n请分析以下邮件内容。\n\n邮件主题:\n---\n${truncatedSubject}\n---\n\n邮件文本内容:\n---\n${truncatedText}\n---\n\n你的任务:\n1. 在邮件主题或邮件文本内容中寻找一个验证码（通常是4到8位的数字或字母数字组合，有时可能包含连字符，例如 123-456 或 AB12CD）。\n2. 如果找到验证码，请只返回验证码本身 (例如："123456" 或 "AB12CD")。\n3. 如果在邮件主题和文本内容中都没有找到明确的验证码，请准确返回字符串 "NOT_FOUND"。\n4. 不要在你的回答前后添加任何解释、介绍性文字或其他任何字符。只需要返回验证码或 "NOT_FOUND"。`;
    try {
        const response = await fetch(`${OPENAI_API_BASE_URL}/chat/completions`, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.1, max_tokens: 50 }),
        });
        if (!response.ok) { console.error(`[OpenAI] API 请求失败: ${response.status} ${await response.text()}`); return { type: "none", value: null }; }
        const data = await response.json();
        const assistantMessage = data.choices?.[0]?.message?.content?.trim();
        if (assistantMessage && assistantMessage !== "NOT_FOUND" && /^[a-zA-Z0-9-]{3,20}$/.test(assistantMessage) && !assistantMessage.includes('/') && !assistantMessage.includes(':')) {
            console.log(`[OpenAI] 提取到的验证码: ${assistantMessage}`);
            return { type: "code", value: assistantMessage };
        } else {
            console.log(`[OpenAI] 未找到验证码或模型返回 "${assistantMessage}" 不符合预期格式。`);
        }
    } catch (error) { console.error("[OpenAI] 调用 API 时发生错误:", error.message); }
    return { type: "none", value: null };
}

// --- Bot 命令 ---

// /start 和 /help 命令
bot.command(["start", "help"], async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) { return ctx.reply("抱歉，无法识别您的用户ID。"); }
    const userApiKey = await getUserUnsendApiKey(userId);

    let helpText = `你好！👋 这是一个临时邮件和通知机器人。\n\n`;
    helpText += `📬 <b>邮件通知 Webhook:</b>\n`;
    helpText += `你的专属邮件通知 Webhook 地址是:\n`;
    helpText += `<code>${DENO_DEPLOY_BASE_URL}/${userId}</code>\n`;
    helpText += `请配置到 <a href="https://unsend.de/profile">Moemail 个人资料页</a>。\n\n`;

    helpText += `🔑 <b>API Key 管理:</b>\n`;
    helpText += `  <code>/key</code> &lt;你的API_Key&gt; - 设置/更新你的 Moemail API Key。\n`;
    if (userApiKey) { helpText += `✅ 当前已设置 API Key。\n\n`; }
    else { helpText += `❌ 当前未设置 API Key。请使用 /key 设置以使用邮箱管理功能。\n\n`; }

    helpText += `📧 <b>临时邮箱管理 (需设置API Key):</b>\n`;
    helpText += `/list - 查看可用的邮箱域名。\n`;
    helpText += `<code>/add</code> [名称] [有效期] [域名] - 创建临时邮箱。\n`;
    helpText += `  - 无参数则创建随机名称, unsend.de 域名, 1天有效期的邮箱。\n`;
    helpText += `  - 例如: /add mymail 3d unsend.de \n`;
    helpText += `  - 有效期: <code>1h</code>, <code>1d</code>, <code>3d</code>, <code>perm</code> \n`;
    helpText += `/mails - 查看你创建的所有临时邮箱列表。\n`;
    helpText += `<code>/mail</code> &lt;emailId&gt; [cursor] - 查看指定邮箱内的邮件列表 (可选分页符)。\n`;
    helpText += `<code>/view</code> &lt;emailId&gt; &lt;messageId&gt; - 查看指定邮件内容 (并尝试AI提取验证码)。\n`;
    helpText += `<code>/del</code> &lt;emailId&gt; - 删除指定的临时邮箱。\n\n`;


    if (OPENAI_API_KEY) { helpText += `✨ <b>AI 功能:</b> 已启用AI验证码提取 (模型: ${OPENAI_MODEL})。\n`; }
    else { helpText += `ℹ️ <b>AI 功能:</b> AI验证码提取未启用 (缺少 OPENAI_API_KEY)。\n`; }
    helpText += `\n祝您使用愉快！`;
    await ctx.reply(helpText, { parse_mode: "HTML", disable_web_page_preview: true });
});

// /key 命令
bot.command("key", async (ctx) => {
    if (!kv) { return ctx.reply("抱歉，内部存储服务暂时不可用，无法处理此命令。"); }
    const userId = ctx.from?.id;
    if (!userId) { return ctx.reply("无法识别您的用户ID。"); }
    const apiKey = ctx.match;
    if (!apiKey || apiKey.trim() === "") { return ctx.reply("请提供您的 unsend.de API Key。\n用法: <code>/key YOUR_API_KEY</code>", { parse_mode: "HTML" }); }

    const success = await saveUserUnsendApiKey(userId, apiKey.trim());
    if (success) { await ctx.reply("✅ 您的 unsend.de API Key 已成功保存！"); }
    else { await ctx.reply("❌ 保存 API Key 时发生错误，请稍后再试。"); }
});

// /list 命令
bot.command("list", async (ctx) => {
    if (!kv) { return ctx.reply("抱歉，内部存储服务暂时不可用，无法处理此命令。"); }
    const userId = ctx.from?.id;
    if (!userId) return ctx.reply("无法识别您的用户ID。");
    const userApiKey = await getUserUnsendApiKey(userId);
    if (!userApiKey) { return ctx.reply("请先使用 <code>/key &lt;API_Key&gt;</code> 命令设置您的 unsend.de API Key。", { parse_mode: "HTML" }); }

    await ctx.reply("正在获取可用域名列表，请稍候...");
    const response = await getAvailableDomains(userApiKey);
    if (response.success && response.data && response.data.length > 0) {
        let message = "可用的邮箱域名列表:\n";
        response.data.forEach(domain => { message += `  - <code>${domain}</code>\n`; });
        await ctx.reply(message, { parse_mode: "HTML" });
    } else if (response.success && response.data && response.data.length === 0) {
        await ctx.reply("目前没有可用的邮箱域名。");
    } else {
        await ctx.reply(`获取域名列表失败: ${response.error || "未知错误"}`);
    }
});

// /add 命令
bot.command("add", async (ctx) => {
    if (!kv) { return ctx.reply("抱歉，内部存储服务暂时不可用，无法处理此命令。"); }
    const userId = ctx.from?.id;
    if (!userId) return ctx.reply("无法识别您的用户ID。");
    const userApiKey = await getUserUnsendApiKey(userId);
    if (!userApiKey) { return ctx.reply("请先使用 <code>/key &lt;API_Key&gt;</code> 命令设置您的 unsend.de API Key。", { parse_mode: "HTML" }); }

    const args = ctx.match.trim().split(/\s+/).filter(Boolean);

    let name: string | undefined;
    let durationCode: string;
    let domain: string;
    let expiryTime: number;

    if (args.length === 0) {
        durationCode = "1d";
        domain = "unsend.de";
        console.log(`[AddCmd] 无参数，使用默认值: duration=${durationCode}, domain=${domain}`);
    } else if (args.length === 3) {
        [name, durationCode, domain] = args;
    } else {
        return ctx.reply(
            "参数格式不正确。\n用法: <code>/add [名称] [有效期] [域名]</code>\n" +
            "  <i>(无参数则创建随机名称, unsend.de 域名, 1天有效期的邮箱)</i>\n" +
            "例如: <code>/add mytest 3d unsend.de</code>\n" +
            "有效期代码: <code>1h</code>, <code>1d</code>, <code>3d</code>, <code>perm</code>",
            { parse_mode: "HTML" }
        );
    }

    const expiryTimeMap: Record<string, number> = { "1h": 3600000, "1d": 86400000, "3d": 259200000, "perm": 0 };
    if (!expiryTimeMap.hasOwnProperty(durationCode.toLowerCase())) {
        return ctx.reply("无效的有效期代码。可用: <code>1h</code>, <code>1d</code>, <code>3d</code>, <code>perm</code>", { parse_mode: "HTML" });
    }
    expiryTime = expiryTimeMap[durationCode.toLowerCase()];

    const displayAddressPrefix = name || "随机名称";
    await ctx.reply(`正在创建邮箱 <code>${displayAddressPrefix}@${domain}</code>，请稍候...`, { parse_mode: "HTML" });

    const payload: GenerateEmailPayload = { expiryTime, domain };
    if (name) { payload.name = name; }

    const response = await generateTempEmail(userApiKey, payload);
    if (response.success && response.data) {
        const createdEmail = response.data;
        let message = `✅ 邮箱创建成功！\n\n` +
            `<b>ID:</b> <code>${createdEmail.id}</code>\n` +
            `<b>地址:</b> <code>${createdEmail.email}</code>\n`;
        if (createdEmail.expiresAt) {
             const expiryDate = new Date(createdEmail.expiresAt);
             const formattedExpiry = expiryDate.toISOString() === "9999-01-01T00:00:00.000Z" || createdEmail.expiresAt.startsWith("9999")
                ? "永久" : expiryDate.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
            message += `<b>过期时间:</b> ${formattedExpiry}\n`;
        }
        await ctx.reply(message, { parse_mode: "HTML" });
    } else {
        await ctx.reply(`创建邮箱失败: ${response.error || "未知错误"}`);
    }
});

// /mails (列出用户所有邮箱) 和 /mail <emailId> (列出指定邮箱内邮件)
bot.command(["mails", "mail"], async (ctx) => {
    if (!kv) { return ctx.reply("抱歉，内部存储服务暂时不可用，无法处理此命令。"); }
    const userId = ctx.from?.id;
    if (!userId) return ctx.reply("无法识别您的用户ID。");

    const userApiKey = await getUserUnsendApiKey(userId);
    if (!userApiKey) { return ctx.reply("请先使用 <code>/key &lt;API_Key&gt;</code> 命令设置您的 unsend.de API Key。", { parse_mode: "HTML" }); }

    const commandArgs = ctx.match.trim().split(/\s+/).filter(Boolean);
    const firstArg = commandArgs[0];
    const secondArg = commandArgs[1];

    if (ctx.message?.text?.startsWith("/mails") || (ctx.message?.text?.startsWith("/mail") && commandArgs.length === 0) || (ctx.message?.text?.startsWith("/mail") && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(firstArg) === false && firstArg !== undefined )) {
        // --- 逻辑: 列出用户所有邮箱 ---
        const cursor = (ctx.message?.text?.startsWith("/mails")) ? firstArg : undefined;
        await ctx.reply(cursor ? `正在获取下一页您的邮箱列表...` : `正在获取您的邮箱列表，请稍候...`);
        const response = await listUserEmails(userApiKey, cursor);

        if (response.success && response.data) {
            const emailData = response.data;
            if (emailData.emails && emailData.emails.length > 0) {
                let message = "您的临时邮箱列表:\n\n";
                emailData.emails.forEach(item => {
                    const displayAddress = item.email || item.address;
                    const expiryDate = new Date(item.expiresAt);
                    const formattedExpiry = expiryDate.toISOString() === "9999-01-01T00:00:00.000Z" || item.expiresAt.startsWith("9999")
                        ? "永久" : expiryDate.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
                    message += `📧 <b>地址:</b> <code>${displayAddress}</code>\n` +
                               `<b>ID:</b> <code>${item.id}</code>\n` +
                               `<b>创建于:</b> ${new Date(item.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n` +
                               `<b>过期于:</b> ${formattedExpiry}\n` +
                               `（使用 <code>/mail ${item.id}</code> 查看当前邮箱中的邮件）\n\n`;
                });
                if (emailData.nextCursor) { message += `\n若要获取更多邮箱，请使用命令:\n<code>/mails ${emailData.nextCursor}</code>`; }
                else { message += "\n没有更多邮箱了。"; }
                await ctx.reply(message, { parse_mode: "HTML" });
            } else {
                await ctx.reply("您还没有创建任何临时邮箱，或当前列表为空。");
            }
        } else {
            await ctx.reply(`获取您的邮箱列表失败: ${response.error || "未知错误"}`);
        }
    } else if (ctx.message?.text?.startsWith("/mail") && firstArg && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(firstArg)) {
        // --- 逻辑: 列出指定邮箱内的邮件 /mail <emailId> [cursor] ---
        const emailId = firstArg;
        const cursor = secondArg;
        await ctx.reply(cursor ? `正在获取邮箱 <code>${emailId}</code> 内的下一页邮件...` : `正在获取邮箱 <code>${emailId}</code> 内的邮件列表，请稍候...`, { parse_mode: "HTML" });
        const response = await getEmailsInMailbox(userApiKey, emailId, cursor);

        if (response.success && response.data) {
            const mailboxData = response.data;
            if (mailboxData.messages && mailboxData.messages.length > 0) {
                let message = `邮箱 <code>${emailId}</code> 内的邮件:\n\n`;
                mailboxData.messages.forEach(msg => {
                    const receivedDate = new Date(msg.received_at);
                    message += `📩 <b>主题:</b> ${(msg.subject || "无主题").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n` +
                               `<b>来自:</b> ${(msg.from_address || "未知发件人").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n` +
                               `<b>时间:</b> ${receivedDate.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n` +
                               `<b>邮件ID:</b> <code>${msg.id}</code>\n` +
                               `(查看详情: <code>/view ${emailId} ${msg.id}</code>)\n\n`;
                });
                if (mailboxData.nextCursor) {
                    message += `\n若要获取更多邮件，请使用命令:\n<code>/mail ${emailId} ${mailboxData.nextCursor}</code>`;
                } else {
                    message += "\n没有更多邮件了。";
                }
                await ctx.reply(message, { parse_mode: "HTML" });
            } else {
                await ctx.reply(`邮箱 <code>${emailId}</code> 内没有邮件，或列表为空。`, { parse_mode: "HTML" });
            }
        } else {
            await ctx.reply(`获取邮箱 <code>${emailId}</code> 内的邮件列表失败: ${response.error || "未知错误"}`, { parse_mode: "HTML" });
        }
    } else {
         await ctx.reply("命令使用不正确。请参考 /help 获取帮助。");
    }
});


// /view <emailId> <messageId> 命令
bot.command("view", async (ctx) => {
    if (!kv) { return ctx.reply("抱歉，内部存储服务暂时不可用，无法处理此命令。"); }
    const userId = ctx.from?.id;
    if (!userId) return ctx.reply("无法识别您的用户ID。");

    const userApiKey = await getUserUnsendApiKey(userId);
    if (!userApiKey) {
        return ctx.reply("请先使用 <code>/key &lt;API_Key&gt;</code> 命令设置您的 unsend.de API Key。", { parse_mode: "HTML" });
    }

    const args = ctx.match.trim().split(/\s+/);
    if (args.length !== 2) {
        return ctx.reply("参数不足或过多。\n用法: <code>/view &lt;emailId&gt; &lt;messageId&gt;</code>", { parse_mode: "HTML" });
    }
    const [paramEmailId, paramMessageId] = args;

    await ctx.reply(`正在获取邮件 <code>${paramMessageId}</code> (来自邮箱 <code>${paramEmailId}</code>) 的内容...`, { parse_mode: "HTML" });
    const response = await getSingleEmailMessage(userApiKey, paramEmailId, paramMessageId);

    if (response.success && response.data) {
        const mailData = response.data;

        const fromAddressDisplay = mailData.from_address || "未知发件人";
        const subjectDisplay = mailData.subject || "无主题";
        const receivedAtDisplay = mailData.received_at ? new Date(mailData.received_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未知时间";
        const messageIdDisplay = mailData.id || "未知邮件ID";

        let message = `📬 <b>邮件详情</b>\n\n` +
            `<b>来自:</b> ${fromAddressDisplay.replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n` +
            `<b>主题:</b> ${subjectDisplay.replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n` +
            `<b>接收时间:</b> ${receivedAtDisplay}\n\n` +
            `<b>邮件ID:</b> <code>${messageIdDisplay}</code>\n` +
            `<b>邮箱ID:</b> <code>${paramEmailId}</code>\n\n` +
            `--- 内容 (纯文本) ---\n`;

        const textContent = mailData.content || "无纯文本内容。";
        message += textContent.substring(0, 3000).replace(/</g, "&lt;").replace(/>/g, "&gt;");
        if (textContent.length > 3000) {
            message += "\n...(内容过长，已截断)";
        }

        // 增加 AI 提取验证码功能
        if (OPENAI_API_KEY) {
            const aiSubject = mailData.subject || "";
            const aiContent = mailData.content || "";
            if (aiSubject || aiContent) {
                
                await ctx.reply(message, { parse_mode: "HTML" }); 
                
                const verificationResult = await extractVerificationCode(aiSubject, aiContent);
                if (verificationResult.type === "code" && verificationResult.value) {
                    await ctx.reply(`🔑 <b>AI提取的验证码:</b> <code>${verificationResult.value.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`, { parse_mode: "HTML" });
                } else {
                    await ctx.reply(`ℹ️ AI 未能提取到验证码。`, { parse_mode: "HTML" });
                }
                return; 
            }
        }
        // 如果没有启用AI或没有内容供AI分析，则直接发送已构建的消息
        await ctx.reply(message, { parse_mode: "HTML" });


    } else {
        await ctx.reply(`获取邮件内容失败: ${response.error || "未知错误"}`);
    }
});

// /del <emailId> 命令
bot.command("del", async (ctx) => {
    if (!kv) { return ctx.reply("抱歉，内部存储服务暂时不可用，无法处理此命令。"); }
    const userId = ctx.from?.id;
    if (!userId) return ctx.reply("无法识别您的用户ID。");

    const userApiKey = await getUserUnsendApiKey(userId);
    if (!userApiKey) {
        return ctx.reply("请先使用 <code>/key &lt;API_Key&gt;</code> 命令设置您的 unsend.de API Key。", { parse_mode: "HTML" });
    }

    const emailId = ctx.match.trim();
    if (!emailId || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(emailId)) {
        return ctx.reply("请提供有效的邮箱ID。\n用法: <code>/del &lt;emailId&gt;</code>", { parse_mode: "HTML" });
    }

    await ctx.reply(`正在尝试删除邮箱 <code>${emailId}</code>...`, { parse_mode: "HTML" });
    const response = await deleteTempEmail(userApiKey, emailId);

    if (response.success) {
        await ctx.reply(`✅ 邮箱 <code>${emailId}</code> 已成功删除。`, { parse_mode: "HTML" });
    } else {
        if (response.statusCode === 404) {
            await ctx.reply(`❌ 删除邮箱 <code>${emailId}</code> 失败：未找到该邮箱，或已被删除。`, { parse_mode: "HTML" });
        } else if (response.statusCode === 403) {
            await ctx.reply(`❌ 删除邮箱 <code>${emailId}</code> 失败：您没有权限删除此邮箱。`, { parse_mode: "HTML" });
        }
        else {
            await ctx.reply(`❌ 删除邮箱 <code>${emailId}</code> 失败: ${response.error || "未知API错误"}`, { parse_mode: "HTML" });
        }
    }
});


// --- GrammY Webhook 处理程序 (用于 Telegram 更新) ---
const processTelegramUpdate = webhookCallback(bot, "std/http");

// --- HTTP 服务器逻辑 ---
serve(
    async (request: Request, connInfo: ConnInfo) => {
        const url = new URL(request.url);
        const pathname = url.pathname;
        const method = request.method;
        const clientAddr = connInfo.remoteAddr as Deno.NetAddr;

        console.log(`[${new Date().toISOString()}] 收到请求: ${method} ${pathname} 来自 ${clientAddr.hostname}:${clientAddr.port}`);

        try {
            // 路由 1: Telegram Bot Webhook 端点
            if (method === "POST" && pathname === TELEGRAM_WEBHOOK_PATH) {
                if (request.headers.get("X-Webhook-Event")) {
                    console.warn(`[${new Date().toISOString()}] 在 Telegram Bot 的指定路径 ('${TELEGRAM_WEBHOOK_PATH}') 上收到了自定义邮件 Webhook 事件。`);
                    return new Response(`此路径用于 Telegram Bot 更新。邮件 Webhook 应 POST 到 /<USER_ID>。`,{ status: 400 });
                }
                console.log(`[${new Date().toISOString()}] 正在处理路径上的 Telegram 更新: ${TELEGRAM_WEBHOOK_PATH}`);
                return await processTelegramUpdate(request);
            }

            // 路由 2: 自定义邮件通知 Webhook
            const pathSegments = pathname.split("/").filter(Boolean);
            if (method === "POST" && pathSegments.length === 1 && /^\d+$/.test(pathSegments[0])) {
                const userIdStr = pathSegments[0];
                const eventType = request.headers.get("X-Webhook-Event");
                const contentType = request.headers.get("Content-Type");

                if (eventType !== "new_message") { return new Response("无效的 X-Webhook-Event 请求头。", { status: 400 }); }
                if (!contentType || !contentType.toLowerCase().includes("application/json")) { return new Response("无效的 Content-Type 请求头。", { status: 415 });}

                try {
                    const payload = await request.json();
                    console.log(`[${new Date().toISOString()}] 收到用户 ${userIdStr} 的 'new_message' Webhook。主题: "${payload.subject}"`);
                    const requiredFields = ["emailId", "messageId", "fromAddress", "subject", "receivedAt", "toAddress"];
                    if (!("content" in payload || "html" in payload) && !("subject" in payload)) { return new Response("Payload 中缺少必需字段: content/html 或 subject", { status: 400 });}
                    for (const field of requiredFields) { if (!(field in payload)) { return new Response(`Payload 中缺少必需字段: ${field}`, { status: 400 }); }}

                    const emailSubject = payload.subject || "";
                    const emailTextContent = payload.content || "";

                    let messageText = `📧 <b>新邮件抵达 (${payload.toAddress})</b>\n\n` +
                        `<b>发件人:</b> ${(payload.fromAddress || "未知发件人").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n` +
                        `<b>主题:</b> ${emailSubject.replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n` +
                        `<b>时间:</b> ${new Date(payload.receivedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n` +
                        `<b>内容预览:</b>\n${(emailTextContent || "无纯文本内容").substring(0, 250).replace(/</g, "&lt;").replace(/>/g, "&gt;")}${(emailTextContent || "").length > 250 ? "..." : ""}`;

                    if (OPENAI_API_KEY) {
                        const verificationResult = await extractVerificationCode(emailSubject, emailTextContent);
                        if (verificationResult.type === "code" && verificationResult.value) {
                            messageText += `\n\n🔑 <b>AI提取的验证码:</b> <code>${verificationResult.value.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`;
                        }
                    }
                    // 新增：追加查看完整邮件的提示
                    messageText += `\n\n查看完整邮件：<code>/view ${payload.emailId} ${payload.messageId}</code>`;

                    await bot.api.sendMessage(userIdStr, messageText, { parse_mode: "HTML", disable_web_page_preview: true });
                    console.log(`[${new Date().toISOString()}] 已成功向用户 ${userIdStr} 发送邮件 ${payload.emailId} 的通知`);
                    return new Response("Webhook 处理成功。", { status: 200 });

                } catch (error) {
                    console.error(`[${new Date().toISOString()}] 处理用户 ${userIdStr} 的邮件 Webhook 时发生错误:`, error.message);
                    if (error instanceof SyntaxError) { return new Response("无效的 JSON Payload。", { status: 400 }); }
                    if (error instanceof GrammyError) {
                        console.warn(`[GrammyError] 发送给用户 ${userIdStr} 失败: ${error.description}`);
                        return new Response("Webhook 已确认，但 Telegram 通知失败。", { status: 202 });
                    }
                    return new Response("处理 Webhook 时发生内部服务器错误。", { status: 500 });
                }
            }

            // 路由 3: 根 GET 请求
            if (method === "GET" && pathname === "/") {
                let statusMessage = `临时邮件 Telegram 机器人 Webhook 服务\n\n` +
                    `服务状态: 运行中 🚀\n` +
                    `部署地址: ${DENO_DEPLOY_BASE_URL}\n` +
                    `Telegram Bot Webhook 路径: ${TELEGRAM_WEBHOOK_PATH}\n` +
                    `Unsend.de API Base: ${UNSEND_API_BASE_URL}\n` +
                    `邮件通知 Webhook 格式: ${DENO_DEPLOY_BASE_URL}/<您的Telegram用户ID>\n\n`;
                if (OPENAI_API_KEY) { statusMessage += `AI 验证码提取功能: 已启用\n`; }
                else { statusMessage += `AI 验证码提取功能: 未启用\n`; }
                statusMessage += `KV 存储状态: ${kv ? '可用' : '不可用 (部分功能可能受限)'}\n`;
                statusMessage += `请通过 Telegram 与机器人交互 (\`/start\` 或 \`/help\`)。`;
                return new Response(statusMessage, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
            }

            // 路由 4: Addy.io 兼容 API 端点 (Bitwarden 集成)
            // POST /api/v1/aliases
            if (method === "POST" && pathname === "/api/v1/aliases") {
                const authHeader = request.headers.get("Authorization");
                if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
                    console.warn("[AddyCompatAPI] 缺少或无效的 Authorization 请求头");
                    return new Response(JSON.stringify({ error: "Unauthorized: Missing or invalid API Key." }), { status: 401, headers: { "Content-Type": "application/json" } });
                }
                const clientUnsendApiKey = authHeader.substring(7).trim(); // 提取 token

                if (!clientUnsendApiKey) {
                    console.warn("[AddyCompatAPI] Authorization 请求头中的 API Key 为空");
                    return new Response(JSON.stringify({ error: "Unauthorized: Empty API Key." }), { status: 401, headers: { "Content-Type": "application/json" } });
                }

                let bitwardenPayload;
                try {
                    bitwardenPayload = await request.json();
                } catch (e) {
                    console.error("[AddyCompatAPI] 无效的 JSON payload:", e.message);
                    return new Response(JSON.stringify({ error: "Bad Request: Invalid JSON payload." }), { status: 400, headers: { "Content-Type": "application/json" } });
                }

                const { domain: requestedDomain, description } = bitwardenPayload;

                if (!requestedDomain || typeof requestedDomain !== 'string' || requestedDomain.trim() === '') {
                    console.warn("[AddyCompatAPI] 请求体中缺少或无效的 'domain'");
                    return new Response(JSON.stringify({ error: "Bad Request: Missing or invalid 'domain'." }), { status: 400, headers: { "Content-Type": "application/json" } });
                }
                if (description) {
                    console.log(`[AddyCompatAPI] 收到描述: ${description}`); // 可以选择性记录
                }

                const unsendPayload: GenerateEmailPayload = {
                    domain: requestedDomain.trim(),
                    expiryTime: 86400000, // 默认为1天
                    // 'name' (前缀) 将被省略，让 unsend.de 自动生成
                };

                console.log(`[AddyCompatAPI] 调用 unsend.de 生成邮箱，域名: ${unsendPayload.domain}`);
                const unsendResponse = await generateTempEmail(clientUnsendApiKey, unsendPayload);

                if (unsendResponse.success && unsendResponse.data && unsendResponse.data.email) {
                    const responseToBitwarden = {
                        data: {
                            email: unsendResponse.data.email,
                            // Bitwarden 的 Addy.io 集成似乎只需要 email 字段
                        }
                    };
                    console.log(`[AddyCompatAPI] 成功生成邮箱: ${unsendResponse.data.email}。正在响应 Bitwarden。`);
                    return new Response(JSON.stringify(responseToBitwarden), {
                        status: 201, // Created
                        headers: { "Content-Type": "application/json" },
                    });
                } else {
                    console.error(`[AddyCompatAPI] 通过 unsend.de 生成邮箱失败: ${unsendResponse.error || "来自 unsend.de 的未知错误"}`);
                    let errorStatus = 500;
                    if (unsendResponse.statusCode) {
                        if (unsendResponse.statusCode === 401 || unsendResponse.statusCode === 403) errorStatus = 401;
                        else if (unsendResponse.statusCode === 400) errorStatus = 400;
                    }
                    return new Response(
                        JSON.stringify({ error: `通过 unsend.de 创建别名失败: ${unsendResponse.error || "内部服务器错误"}` }),
                        { status: errorStatus, headers: { "Content-Type": "application/json" } }
                    );
                }
            }

            console.log(`[${new Date().toISOString()}] 未处理的请求: ${method} ${pathname}。正在响应 404。`);
            return new Response("未找到端点。", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] HTTP 处理程序发生严重错误: ${err.message}`, err);
            if (err instanceof HttpError) { return new Response("Telegram 集成错误。", { status: 500 }); }
            return new Response("发生意外的服务器错误。", { status: 500 });
        }
    },
    {
        onListen({ port, hostname }) {
            console.log(`[${new Date().toISOString()}] HTTP 服务器正在监听 ${hostname}:${port}`);
        },
    }
);

// --- 启动消息 ---
console.log(`[${new Date().toISOString()}] Deno 应用正在启动...`);
console.log(`[${new Date().toISOString()}] Bot Token 是否加载: ${BOT_TOKEN ? "是" : "否 (致命错误!)"}`);
console.log(`[${new Date().toISOString()}] Deno Deploy 基础 URL: ${DENO_DEPLOY_BASE_URL}`);
console.log(`[${new Date().toISOString()}] Telegram Bot Webhook: ${DENO_DEPLOY_BASE_URL}${TELEGRAM_WEBHOOK_PATH}`);
console.log(`[${new Date().toISOString()}] Unsend.de API Base URL: ${UNSEND_API_BASE_URL}`);
console.log(`[${new Date().toISOString()}] KV 存储状态: ${kv ? '已初始化' : '初始化失败! 部分依赖KV的功能将不可用。'}`);

if (OPENAI_API_KEY) {
    console.log(`[${new Date().toISOString()}] OpenAI API Key: 已加载。AI 功能: 已启用`);
} else {
    console.log(`[${new Date().toISOString()}] OpenAI API Key: 未设置。AI 功能: 已禁用`);
}
console.log(`[${new Date().toISOString()}] 应用设置完成。等待请求...`);

globalThis.addEventListener("unload", () => {
  if (kv) {
    kv.close();
    console.log("[KV] Deno KV store closed.");
  }
});

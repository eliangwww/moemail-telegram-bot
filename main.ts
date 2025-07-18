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
    Deno.env.get("DENO_DEPLOY_URL") || "https://careful-koala-12.deno.dev/";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_API_BASE_URL = Deno.env.get("OPENAI_API_BASE_URL") || "https://api.openai.com/v1";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-3.5-turbo";

const UNSEND_API_BASE_URL =
    Deno.env.get("UNSEND_API_BASE_URL") || "https://unsend.de/api";

// 可用域名配置
const DOMAINS = Deno.env.get("DOMAINS") || "unsend.de";
const AVAILABLE_DOMAINS = DOMAINS.split("|").map(d => d.trim()).filter(Boolean);

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

// --- 公共验证函数 ---
interface ValidationResult {
    success: boolean;
    error?: string;
    userApiKey?: string;
}

async function validateUserAndApiKey(userId: number | undefined): Promise<ValidationResult> {
    if (!kv) {
        return { success: false, error: "抱歉，内部存储服务暂时不可用，无法处理此命令。" };
    }
    if (!userId) {
        return { success: false, error: "无法识别您的用户ID。" };
    }

    const userApiKey = await getUserUnsendApiKey(userId);
    if (!userApiKey) {
        return { success: false, error: "请先使用 <code>/key &lt;API_Key&gt;</code> 命令设置您的 unsend.de API Key。" };
    }

    return { success: true, userApiKey };
}

// --- Deno KV 辅助函数 (用于存储用户 unsend.de API Key) ---
async function saveUserUnsendApiKey(userId: number, apiKey: string): Promise<boolean> {
    if (!kv) return false;
    try {
        await kv.set(["unsend_api_keys", userId.toString()], apiKey);
        return true;
    } catch (error) {
        console.error(`[KV] Error saving API key for user ${userId}:`, error);
        return false;
    }
}

async function getUserUnsendApiKey(userId: number): Promise<string | null> {
    if (!kv) return null;
    try {
        const result = await kv.get<string>(["unsend_api_keys", userId.toString()]);
        return result.value;
    } catch (error) {
        console.error(`[KV] Error retrieving API key for user ${userId}:`, error);
        return null;
    }
}

// --- 邮箱创建流程状态管理 ---
interface EmailCreationState {
    step: "prefix" | "custom_prefix" | "duration" | "domain" | "confirm";
    prefix?: string;
    duration?: string;
    domain?: string;
}

async function saveEmailCreationState(userId: number, state: EmailCreationState): Promise<boolean> {
    if (!kv) return false;
    try {
        await kv.set(["email_creation_state", userId.toString()], state);
        return true;
    } catch (error) {
        console.error(`[KV] Error saving creation state for user ${userId}:`, error);
        return false;
    }
}

async function getEmailCreationState(userId: number): Promise<EmailCreationState | null> {
    if (!kv) return null;
    try {
        const result = await kv.get<EmailCreationState>(["email_creation_state", userId.toString()]);
        return result.value;
    } catch (error) {
        console.error(`[KV] Error retrieving creation state for user ${userId}:`, error);
        return null;
    }
}

async function clearEmailCreationState(userId: number): Promise<boolean> {
    if (!kv) return false;
    try {
        await kv.delete(["email_creation_state", userId.toString()]);
        return true;
    } catch (error) {
        console.error(`[KV] Error clearing creation state for user ${userId}:`, error);
        return false;
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
        const response = await fetch(url, options);
        if (!response.ok) {
            const errorText = await response.text();
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
        return { success: false, error: (error as Error).message || "网络错误" };
    }
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
    } catch (error) { console.error("[OpenAI] 调用 API 时发生错误:", (error as Error).message); }
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
    helpText += `<code>/add</code> - 创建临时邮箱 (交互式引导)。\n`;
    helpText += `<code>/cancel</code> - 取消当前的邮箱创建流程。\n`;
    helpText += `/box [cursor] - 查看你创建的所有临时邮箱列表。\n`;
    helpText += `<code>/mail</code> &lt;emailId&gt; [cursor] - 查看指定邮箱内的邮件列表 (可选分页符)。\n`;
    helpText += `<code>/view</code> &lt;emailId&gt; &lt;messageId&gt; - 查看指定邮件内容 (并尝试AI提取验证码)。\n`;
    helpText += `<code>/del</code> &lt;emailId&gt; - 删除指定的临时邮箱。\n\n`;


    if (OPENAI_API_KEY) { helpText += `✨ <b>AI 功能:</b> 已启用AI验证码提取 (模型: ${OPENAI_MODEL})。\n`; }
    else { helpText += `ℹ️ <b>AI 功能:</b> AI验证码提取未启用 (缺少 OPENAI_API_KEY)。\n`; }
    helpText += `\n祝您使用愉快！`;
    await ctx.reply(helpText, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
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
    let message = "可用的邮箱域名列表:\n";
    AVAILABLE_DOMAINS.forEach(domain => { message += `  - <code>${domain}</code>\n`; });
    await ctx.reply(message, { parse_mode: "HTML" });
});

// /add 命令 - 交互式创建临时邮箱
bot.command("add", async (ctx) => {
    const validation = await validateUserAndApiKey(ctx.from?.id);
    if (!validation.success) {
        return ctx.reply(validation.error!, { parse_mode: "HTML" });
    }

    // 清除之前的创建状态
    await clearEmailCreationState(ctx.from!.id);

    // 开始第一步：选择前缀
    const state: EmailCreationState = { step: "prefix" };
    await saveEmailCreationState(ctx.from!.id, state);

    const message = `🎯 <b>创建临时邮箱 - 第1步</b>\n\n` +
        `请选择邮箱前缀：\n\n` +
        `💡 前缀将成为您邮箱地址的开头部分`;

    await ctx.reply(message, {
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🎲 随机前缀", callback_data: "prefix_random" },
                    { text: "✏️ 自定义前缀", callback_data: "prefix_custom" }
                ],
                [
                    { text: "❌ 取消", callback_data: "cancel_creation" }
                ]
            ]
        }
    });
});

// /box 命令 - 列出用户所有邮箱
bot.command("box", async (ctx) => {
    const validation = await validateUserAndApiKey(ctx.from?.id);
    if (!validation.success) {
        return ctx.reply(validation.error!, { parse_mode: "HTML" });
    }

    const cursor = ctx.match.trim() || undefined;
    await ctx.reply(cursor ? `正在获取下一页您的邮箱列表...` : `正在获取您的邮箱列表，请稍候...`);
    const response = await listUserEmails(validation.userApiKey!, cursor);

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
            if (emailData.nextCursor) { message += `\n若要获取更多邮箱，请使用命令:\n<code>/box ${emailData.nextCursor}</code>`; }
            else { message += "\n没有更多邮箱了。"; }
            await ctx.reply(message, { parse_mode: "HTML" });
        } else {
            await ctx.reply("您还没有创建任何临时邮箱，或当前列表为空。");
        }
    } else {
        await ctx.reply(`获取您的邮箱列表失败: ${response.error || "未知错误"}`);
    }
});

// /mail <emailId> 命令 - 列出指定邮箱内的邮件
bot.command("mail", async (ctx) => {
    const validation = await validateUserAndApiKey(ctx.from?.id);
    if (!validation.success) {
        return ctx.reply(validation.error!, { parse_mode: "HTML" });
    }

    const commandArgs = ctx.match.trim().split(/\s+/).filter(Boolean);
    const emailId = commandArgs[0];
    const cursor = commandArgs[1];

    if (!emailId || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(emailId)) {
        return ctx.reply("请提供有效的邮箱ID。\n用法: <code>/mail &lt;emailId&gt; [cursor]</code>", { parse_mode: "HTML" });
    }

    const response = await getEmailsInMailbox(validation.userApiKey!, emailId, cursor);

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
});


// /view <emailId> <messageId> 命令
bot.command("view", async (ctx) => {
    const validation = await validateUserAndApiKey(ctx.from?.id);
    if (!validation.success) {
        return ctx.reply(validation.error!, { parse_mode: "HTML" });
    }

    const args = ctx.match.trim().split(/\s+/);
    if (args.length !== 2) {
        return ctx.reply("参数不足或过多。\n用法: <code>/view &lt;emailId&gt; &lt;messageId&gt;</code>", { parse_mode: "HTML" });
    }
    const [paramEmailId, paramMessageId] = args;

    const response = await getSingleEmailMessage(validation.userApiKey!, paramEmailId, paramMessageId);

    if (response.success && response.data) {
        const mailData = response.data;
        const textContent = mailData.content || "无纯文本内容。";

        let message = `📬 <b>邮件详情</b>\n\n` +
            `<b>来自:</b> ${(mailData.from_address || "未知发件人").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n` +
            `<b>主题:</b> ${(mailData.subject || "无主题").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n` +
            `<b>时间:</b> ${mailData.received_at ? new Date(mailData.received_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未知时间"}\n\n` +
            `<b>内容:</b>\n${textContent.substring(0, 2000).replace(/</g, "&lt;").replace(/>/g, "&gt;")}`;

        if (textContent.length > 2000) {
            message += "\n...(内容过长，已截断)";
        }

        await ctx.reply(message, { parse_mode: "HTML" });

        // 添加网页查看链接
        const webViewUrl = `${DENO_DEPLOY_BASE_URL}/view/${ctx.from!.id}/${paramEmailId}/${paramMessageId}`;
        await ctx.reply(`🌐 <b>网页查看:</b> <a href="${webViewUrl}">点击查看完整邮件</a>`, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true }
        });

        // AI 提取验证码
        if (OPENAI_API_KEY && (mailData.subject || textContent)) {
            const verificationResult = await extractVerificationCode(mailData.subject || "", textContent);
            if (verificationResult.type === "code" && verificationResult.value) {
                await ctx.reply(`🔑 <b>验证码:</b> <code>${verificationResult.value}</code>`, { parse_mode: "HTML" });
            }
        }
    } else {
        await ctx.reply(`获取邮件内容失败: ${response.error || "未知错误"}`);
    }
});

// /del <emailId> 命令
bot.command("del", async (ctx) => {
    const validation = await validateUserAndApiKey(ctx.from?.id);
    if (!validation.success) {
        return ctx.reply(validation.error!, { parse_mode: "HTML" });
    }

    const emailId = ctx.match.trim();
    if (!emailId || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(emailId)) {
        return ctx.reply("请提供有效的邮箱ID。\n用法: <code>/del &lt;emailId&gt;</code>", { parse_mode: "HTML" });
    }

    const response = await deleteTempEmail(validation.userApiKey!, emailId);

    if (response.success) {
        await ctx.reply(`✅ 邮箱已成功删除。`, { parse_mode: "HTML" });
    } else {
        const errorMsg = response.statusCode === 404 ? "未找到该邮箱" :
                        response.statusCode === 403 ? "没有权限删除此邮箱" :
                        response.error || "未知错误";
        await ctx.reply(`❌ 删除失败: ${errorMsg}`, { parse_mode: "HTML" });
    }
});

// /cancel 命令 - 取消邮箱创建流程
bot.command("cancel", async (ctx) => {
    if (!kv) { return ctx.reply("抱歉，内部存储服务暂时不可用，无法处理此命令。"); }
    const userId = ctx.from?.id;
    if (!userId) return ctx.reply("无法识别您的用户ID。");

    const state = await getEmailCreationState(userId);
    if (!state) {
        return ctx.reply("您当前没有进行中的邮箱创建流程。");
    }

    await clearEmailCreationState(userId);
    await ctx.reply("✅ 已取消邮箱创建流程。");
});

// --- 回调查询处理器 (处理内联键盘按钮点击) ---
bot.on("callback_query", async (ctx) => {
    if (!kv) return; // 如果 KV 不可用，跳过处理

    const userId = ctx.from?.id;
    if (!userId) return;

    const callbackData = ctx.callbackQuery.data;
    if (!callbackData) return;

    // 处理取消创建
    if (callbackData === "cancel_creation") {
        await clearEmailCreationState(userId);
        await ctx.editMessageText("❌ 已取消邮箱创建流程。");
        await ctx.answerCallbackQuery();
        return;
    }

    // 检查用户是否在邮箱创建流程中
    const state = await getEmailCreationState(userId);
    if (!state) {
        await ctx.answerCallbackQuery("创建流程已过期，请重新使用 /add 命令。");
        return;
    }

    const userApiKey = await getUserUnsendApiKey(userId);
    if (!userApiKey) {
        await clearEmailCreationState(userId);
        await ctx.editMessageText("请先使用 <code>/key &lt;API_Key&gt;</code> 命令设置您的 unsend.de API Key。", { parse_mode: "HTML" });
        await ctx.answerCallbackQuery();
        return;
    }

    try {
        if (state.step === "prefix") {
            // 第一步：处理前缀选择
            if (callbackData === "prefix_random") {
                // 使用随机前缀
                const newState: EmailCreationState = { step: "duration", prefix: undefined };
                await saveEmailCreationState(userId, newState);

                const message = `🕐 <b>创建临时邮箱 - 第2步</b>\n\n` +
                    `前缀：随机\n\n` +
                    `请选择邮箱有效期：`;

                await ctx.editMessageText(message, {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "⏰ 1小时", callback_data: "duration_1h" },
                                { text: "📅 1天", callback_data: "duration_1d" }
                            ],
                            [
                                { text: "📅 3天", callback_data: "duration_3d" },
                                { text: "♾️ 永久", callback_data: "duration_perm" }
                            ],
                            [
                                { text: "❌ 取消", callback_data: "cancel_creation" }
                            ]
                        ]
                    }
                });
                await ctx.answerCallbackQuery();
            } else if (callbackData === "prefix_custom") {
                // 输入自定义前缀
                const newState: EmailCreationState = { step: "custom_prefix" };
                await saveEmailCreationState(userId, newState);

                const message = `✏️ <b>创建临时邮箱 - 输入前缀</b>\n\n` +
                    `请输入您想要的前缀名称：\n\n` +
                    `💡 前缀要求：1-20个字符，只能包含字母、数字、下划线和连字符\n` +
                    `例如：<code>mytest</code>、<code>work_email</code>\n\n` +
                    `输入完成后，请发送前缀名称。`;

                await ctx.editMessageText(message, {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "❌ 取消", callback_data: "cancel_creation" }
                            ]
                        ]
                    }
                });
                await ctx.answerCallbackQuery();
            }

        // custom_prefix 步骤由文本消息处理器处理

        } else if (state.step === "duration") {
            // 第二步：处理有效期选择
            const durationMap: Record<string, string> = {
                "duration_1h": "1h",
                "duration_1d": "1d",
                "duration_3d": "3d",
                "duration_perm": "perm"
            };
            const selectedDuration = durationMap[callbackData];

            if (!selectedDuration) {
                await ctx.answerCallbackQuery("无效的选择");
                return;
            }

            // 进入第三步：选择域名
            const newState: EmailCreationState = {
                step: "domain",
                prefix: state.prefix,
                duration: selectedDuration
            };
            await saveEmailCreationState(userId, newState);

            const message = `🌐 <b>创建临时邮箱 - 第3步</b>\n\n` +
                `前缀：${state.prefix || "随机"}\n` +
                `有效期：${selectedDuration}\n\n` +
                `请选择邮箱域名：`;

            // 创建域名按钮
            const domainButtons = AVAILABLE_DOMAINS.map((domain: string, index: number) => ({
                text: `${domain}`,
                callback_data: `domain_${index}`
            }));

            // 将按钮分组，每行最多2个
            const keyboard: Array<Array<{text: string, callback_data: string}>> = [];
            for (let i = 0; i < domainButtons.length; i += 2) {
                keyboard.push(domainButtons.slice(i, i + 2));
            }
            keyboard.push([{ text: "❌ 取消", callback_data: "cancel_creation" }]);

            await ctx.editMessageText(message, {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
            await ctx.answerCallbackQuery();

        } else if (state.step === "domain") {
            // 第三步：处理域名选择
            if (!callbackData.startsWith("domain_")) {
                await ctx.answerCallbackQuery("无效的选择");
                return;
            }

            const domainIndex = parseInt(callbackData.replace("domain_", ""));
            if (isNaN(domainIndex) || domainIndex < 0 || domainIndex >= AVAILABLE_DOMAINS.length) {
                await ctx.answerCallbackQuery("无效的域名选择");
                return;
            }

            const selectedDomain = AVAILABLE_DOMAINS[domainIndex];

            // 进入确认步骤
            const newState: EmailCreationState = {
                step: "confirm",
                prefix: state.prefix,
                duration: state.duration!,
                domain: selectedDomain
            };
            await saveEmailCreationState(userId, newState);

            const displayPrefix = state.prefix || "随机";
            const previewAddress = state.prefix ? `${state.prefix}@${selectedDomain}` : `随机前缀@${selectedDomain}`;
            const message = `✅ <b>创建临时邮箱 - 确认</b>\n\n` +
                `<b>前缀：</b>${displayPrefix}\n` +
                `<b>有效期：</b>${state.duration}\n` +
                `<b>域名：</b>${selectedDomain}\n` +
                `<b>预览：</b><code>${previewAddress}</code>\n\n` +
                `确认创建吗？`;

            await ctx.editMessageText(message, {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "✅ 确认创建", callback_data: "confirm_yes" },
                            { text: "❌ 取消", callback_data: "confirm_no" }
                        ]
                    ]
                }
            });
            await ctx.answerCallbackQuery();

        } else if (state.step === "confirm") {
            // 确认步骤：处理最终确认
            if (callbackData === "confirm_no") {
                await clearEmailCreationState(userId);
                await ctx.editMessageText("❌ 已取消创建邮箱。");
                await ctx.answerCallbackQuery();
                return;
            }

            if (callbackData !== "confirm_yes") {
                await ctx.answerCallbackQuery("无效的选择");
                return;
            }

            // 创建邮箱
            const expiryTimeMap: Record<string, number> = { "1h": 3600000, "1d": 86400000, "3d": 259200000, "perm": 0 };
            const expiryTime = expiryTimeMap[state.duration!];

            const displayPrefix = state.prefix || "随机";
            await ctx.editMessageText(`⏳ 正在创建邮箱 <code>${displayPrefix}@${state.domain}</code>，请稍候...`, { parse_mode: "HTML" });
            await ctx.answerCallbackQuery();

            const payload: GenerateEmailPayload = { expiryTime, domain: state.domain! };
            if (state.prefix) { payload.name = state.prefix; }

            const response = await generateTempEmail(userApiKey, payload);

            // 清除创建状态
            await clearEmailCreationState(userId);

            if (response.success && response.data) {
                const createdEmail = response.data;
                let message = `🎉 <b>邮箱创建成功！</b>\n\n` +
                    `<b>ID:</b> <code>${createdEmail.id}</code>\n` +
                    `<b>地址:</b> <code>${createdEmail.email}</code>\n`;
                if (createdEmail.expiresAt) {
                    const expiryDate = new Date(createdEmail.expiresAt);
                    const formattedExpiry = expiryDate.toISOString() === "9999-01-01T00:00:00.000Z" || createdEmail.expiresAt.startsWith("9999")
                        ? "永久" : expiryDate.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
                    message += `<b>过期时间:</b> ${formattedExpiry}\n`;
                }
                message += `\n使用 <code>/mail ${createdEmail.id}</code> 查看邮件`;
                await ctx.editMessageText(message, { parse_mode: "HTML" });
            } else {
                await ctx.editMessageText(`❌ 创建邮箱失败: ${response.error || "未知错误"}`, { parse_mode: "HTML" });
            }
        }
    } catch (error) {
        console.error(`[EmailCreation] Error processing user ${userId} input:`, error);
        await clearEmailCreationState(userId);
        await ctx.reply("❌ 处理过程中发生错误，请重新使用 /add 命令开始创建。");
    }
});

// --- 文本消息处理器 (处理自定义前缀输入) ---
bot.on("message:text", async (ctx) => {
    if (!kv) return;

    const userId = ctx.from?.id;
    if (!userId) return;

    // 检查用户是否在自定义前缀输入步骤
    const state = await getEmailCreationState(userId);
    if (!state || state.step !== "custom_prefix") return;

    const userApiKey = await getUserUnsendApiKey(userId);
    if (!userApiKey) {
        await clearEmailCreationState(userId);
        return ctx.reply("请先使用 <code>/key &lt;API_Key&gt;</code> 命令设置您的 unsend.de API Key。", { parse_mode: "HTML" });
    }

    const userInput = ctx.message.text.trim();

    try {
        // 验证自定义前缀格式
        if (/^[a-zA-Z0-9_-]{1,20}$/.test(userInput)) {
            const newState: EmailCreationState = { step: "duration", prefix: userInput };
            await saveEmailCreationState(userId, newState);

            const message = `🕐 <b>创建临时邮箱 - 第2步</b>\n\n` +
                `前缀：${userInput}\n\n` +
                `请选择邮箱有效期：`;

            await ctx.reply(message, {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "⏰ 1小时", callback_data: "duration_1h" },
                            { text: "📅 1天", callback_data: "duration_1d" }
                        ],
                        [
                            { text: "📅 3天", callback_data: "duration_3d" },
                            { text: "♾️ 永久", callback_data: "duration_perm" }
                        ],
                        [
                            { text: "❌ 取消", callback_data: "cancel_creation" }
                        ]
                    ]
                }
            });
        } else {
            await ctx.reply("❌ 前缀格式不正确。请输入1-20个字符，只能包含字母、数字、下划线和连字符。", { parse_mode: "HTML" });
        }
    } catch (error) {
        console.error(`[EmailCreation] Error processing custom prefix for user ${userId}:`, error);
        await clearEmailCreationState(userId);
        await ctx.reply("❌ 处理过程中发生错误，请重新使用 /add 命令开始创建。");
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
                    messageText += `\n\n📱 查看完整邮件：<code>/view ${payload.emailId} ${payload.messageId}</code>`;
                    messageText += `\n🌐 网页查看：${DENO_DEPLOY_BASE_URL}/view/${userIdStr}/${payload.emailId}/${payload.messageId}`;

                    await bot.api.sendMessage(userIdStr, messageText, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
                    console.log(`[${new Date().toISOString()}] 已成功向用户 ${userIdStr} 发送邮件 ${payload.emailId} 的通知`);
                    return new Response("Webhook 处理成功。", { status: 200 });

                } catch (error) {
                    console.error(`[${new Date().toISOString()}] 处理用户 ${userIdStr} 的邮件 Webhook 时发生错误:`, (error as Error).message);
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

            // 路由 4: 网页查看邮件端点 /view/:tgUserId/:emailId/:messageId
            const viewPathSegments = pathname.match(/^\/view\/(\d+)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/);
            if (method === "GET" && viewPathSegments) {
                const [, tgUserIdStr, emailId, messageId] = viewPathSegments;

                if (!kv) {
                    return new Response("内部服务器错误：存储服务不可用。", { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
                }

                const userApiKey = await getUserUnsendApiKey(parseInt(tgUserIdStr, 10));
                if (!userApiKey) {
                    return new Response("授权失败：无法获取查看此邮件所需的凭据。", { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } });
                }

                const emailResponse = await getSingleEmailMessage(userApiKey, emailId, messageId);

                if (emailResponse.success && emailResponse.data) {
                    const mailData = emailResponse.data;
                    const htmlContent = mailData.html || mailData.content || "<p>此邮件没有可显示的 HTML 或纯文本内容。</p>";

                    // 基础 HTML 包装
                    const fullHtml = `
                        <!DOCTYPE html>
                        <html lang="zh">
                        <head>
                            <meta charset="UTF-8">
                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                            <title>邮件详情: ${(mailData.subject || "无主题").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title>
                            <style>
                                body { font-family: sans-serif; margin: 10px; padding: 0; background-color: #f5f5f5; }
                                .email-container { max-width: 800px; margin: 10px auto; padding: 20px; border: 1px solid #ddd; box-shadow: 0 0 10px rgba(0,0,0,0.1); background-color: white; border-radius: 8px; }
                                .email-header { padding-bottom: 10px; margin-bottom: 20px; border-bottom: 1px solid #eee; }
                                .email-header h1 { font-size: 1.5em; margin: 0 0 5px 0; color: #333; }
                                .email-header p { font-size: 0.9em; color: #555; margin: 5px 0; }
                                .email-body { line-height: 1.6; }
                                .email-body pre { background-color: #f8f8f8; padding: 10px; border-radius: 4px; overflow-x: auto; }
                            </style>
                        </head>
                        <body>
                            <div class="email-container">
                                <div class="email-header">
                                    <h1>${(mailData.subject || "无主题").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</h1>
                                    <p><b>发件人:</b> ${(mailData.from_address || "未知").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
                                    <p><b>接收时间:</b> ${mailData.received_at ? new Date(mailData.received_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未知"}</p>
                                    <p><b>邮件ID:</b> ${messageId}</p>
                                </div>
                                <div class="email-body">
                                    ${htmlContent}
                                </div>
                            </div>
                        </body>
                        </html>
                    `;
                    return new Response(fullHtml, { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 200 });
                } else {
                    let errorHtml = `
                        <!DOCTYPE html>
                        <html lang="zh">
                        <head>
                            <meta charset="UTF-8">
                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                            <title>邮件加载失败</title>
                            <style>
                                body { font-family: sans-serif; margin: 20px; background-color: #f5f5f5; }
                                .error-container { max-width: 600px; margin: 50px auto; padding: 20px; background-color: white; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); text-align: center; }
                                h1 { color: #d32f2f; }
                                p { color: #666; }
                            </style>
                        </head>
                        <body>
                            <div class="error-container">
                                <h1>无法加载邮件</h1>
                                <p>原因: ${emailResponse.error || "未知错误"}</p>
                            </div>
                        </body>
                        </html>
                    `;

                    if (emailResponse.statusCode === 404) {
                        errorHtml = `
                            <!DOCTYPE html>
                            <html lang="zh">
                            <head>
                                <meta charset="UTF-8">
                                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                <title>邮件未找到</title>
                                <style>
                                    body { font-family: sans-serif; margin: 20px; background-color: #f5f5f5; }
                                    .error-container { max-width: 600px; margin: 50px auto; padding: 20px; background-color: white; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); text-align: center; }
                                    h1 { color: #d32f2f; }
                                    p { color: #666; }
                                </style>
                            </head>
                            <body>
                                <div class="error-container">
                                    <h1>邮件未找到</h1>
                                    <p>无法找到指定的邮件，可能已被删除或ID不正确。</p>
                                </div>
                            </body>
                            </html>
                        `;
                    }

                    return new Response(errorHtml, { status: emailResponse.statusCode || 500, headers: { "Content-Type": "text/html; charset=utf-8" } });
                }
            }

            // 路由 5: Addy.io 兼容 API 端点 (Bitwarden 集成)
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
                    console.error("[AddyCompatAPI] 无效的 JSON payload:", (e as Error).message);
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
            console.error(`[${new Date().toISOString()}] HTTP 处理程序发生严重错误: ${(err as Error).message}`, err);
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
console.log(`[${new Date().toISOString()}] 应用启动完成`);
console.log(`[${new Date().toISOString()}] Webhook: ${DENO_DEPLOY_BASE_URL}${TELEGRAM_WEBHOOK_PATH}`);
console.log(`[${new Date().toISOString()}] KV: ${kv ? '✓' : '✗'} | AI: ${OPENAI_API_KEY ? '✓' : '✗'} | 域名: ${AVAILABLE_DOMAINS.length}个`);

globalThis.addEventListener("unload", () => {
  if (kv) {
    kv.close();
    console.log("[KV] Deno KV store closed.");
  }
});

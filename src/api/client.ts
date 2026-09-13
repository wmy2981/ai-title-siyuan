/**
 * OpenAI 兼容 chat completions 客户端。
 *
 * 全部请求经内核的 /api/network/forwardProxy 发出：该端点在服务端用 Go 发起请求，
 * 因此不受浏览器同源策略限制，桌面端、移动端与浏览器端行为一致。
 * 代价是它要求管理员角色（发布服务访客为只读角色，必然 403）。
 *
 * 只实现非流式请求：插件一次只取一小段 JSON，流式带来的复杂度没有收益。
 */
import {fetchSyncPost} from "siyuan";
import {
    chatCompletionsURL,
    modelsURL,
    REASONING_EFFORT_FIELD,
    REASONING_EFFORT_OFF,
    THINKING_CUSTOM,
    THINKING_DISABLED,
    type ApiSettings,
    type BehaviorSettings,
} from "../config";
import {debug, debugError, debugModelText, debugRequest, debugResponse} from "../debug";

const PROXY_URL = "/api/network/forwardProxy";

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface ChatParams {
    system: string;
    user: string;
}

/** 一次响应里模型仍然产生的推理痕迹。 */
export interface ReasoningTrace {
    /** 思维链文本，供应商把它放在 message 里时取到；只报数不返文本时为空串。 */
    text: string;
    /** 供应商自报的推理 token 数，只有 OpenAI 形状的 usage 才给得出。 */
    tokens: number | undefined;
}

export interface ChatResult {
    text: string;
    /** 本次响应里仍带有推理内容时的痕迹，没有则为 undefined。 */
    reasoning?: ReasoningTrace;
}

export class ApiError extends Error {
    constructor(
        message: string,
        /** 是否值得重试。全部 4xx（除 408/409/429）都不可重试。 */
        readonly retryable: boolean,
        readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = "ApiError";
    }
}

/** 响应合法但没有文本内容时的哨兵错误，UI 据此给出「推理耗尽预算」的提示。 */
export const EMPTY_CONTENT = "EMPTY_CONTENT";

/**
 * 关闭推理的请求体字段。
 *
 * 这是唯一一处写 reasoning_effort 的地方，理由见 config.ts 的 REASONING_EFFORT_FIELD。
 * 副作用是：供应商若不认这个参数且不容忍未知字段，会直接 400。
 * 那种情况用户是能看见的（报错原文会原样展示），比下面 thinkingFields 那种
 * 「发出去、被静默忽略、看起来一切正常」的失败好得多。
 */
function reasoningFields(api: ApiSettings): Record<string, unknown> {
    return api.suppressReasoning ? {[REASONING_EFFORT_FIELD]: REASONING_EFFORT_OFF} : {};
}

/**
 * @deprecated 旧版「从 JSON 片段里挑一条」的取值解析。已撤出界面，且**不再调用**。
 *
 * 单独留在这里而不是删掉：恢复旧下拉时把它加回 buildPayload 那一行即可。
 * 之所以要摘掉调用，是因为这两条路径并存时，请求体里发什么取决于两个地方
 * （mergeSettings 负责清旧值、buildPayload 负责拼字段），而 extra_body 那个
 * 静默失效的 bug 正是这样活下来的。现在只有 reasoningFields 一个出口。
 *
 * 导出是为了让它不被 noUnusedLocals 判成死代码。
 */
export function thinkingFields(api: ApiSettings): Record<string, unknown> {
    const raw = api.disableThinking === THINKING_CUSTOM ? api.customThinking : api.disableThinking;
    if (!raw || raw === THINKING_DISABLED) {
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new ApiError(
            `Invalid "disable thinking" JSON: ${raw} (${error instanceof Error ? error.message : String(error)})`,
            false,
        );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ApiError(`"disable thinking" must be a JSON object, got: ${raw}`, false);
    }
    return parsed as Record<string, unknown>;
}

export function buildPayload(
    params: ChatParams,
    api: ApiSettings,
    useMaxCompletionTokens: boolean,
): Record<string, unknown> {
    const payload: Record<string, unknown> = {
        model: api.model.trim(),
        messages: [
            {role: "system", content: params.system},
            {role: "user", content: params.user},
        ] satisfies ChatMessage[],
        temperature: api.temperature,
        stream: false,
    };
    if (api.topP !== null && api.topP !== undefined) {
        payload.top_p = api.topP;
    }
    // top_k 留空就不发送：OpenAI 官方接口对未识别参数直接返回 400。
    if (api.topK !== null && api.topK !== undefined) {
        payload.top_k = api.topK;
    }
    if (api.maxTokens > 0) {
        // max_tokens 已被 OpenAI 标记废弃，但大量兼容服务只认它，所以留好回退路径。
        payload[useMaxCompletionTokens ? "max_completion_tokens" : "max_tokens"] = api.maxTokens;
    }
    return Object.assign(payload, reasoningFields(api));
}

/** 该错误是否表示「不认识 max_completion_tokens」，需要改用 max_tokens 重发。 */
function needsMaxTokensFallback(message: string): boolean {
    return message.includes("max_completion_tokens");
}

function parseRetryAfter(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.round(seconds * 1000);
    }
    const date = Date.parse(value);
    if (!Number.isNaN(date)) {
        return Math.max(0, date - Date.now());
    }
    return undefined;
}

/** 从任意形态的错误响应体里尽力取出可读信息。 */
function extractErrorMessage(status: number, body: string): string {
    try {
        const parsed = JSON.parse(body) as {
            error?: {message?: string};
            message?: string;
            msg?: string;
        };
        const message = parsed.error?.message ?? parsed.message ?? parsed.msg;
        if (message) {
            return message;
        }
    } catch {
        // 网关返回 HTML 或纯文本时走下面的兜底
    }
    const text = body.trim().slice(0, 300);
    return text === "" ? `HTTP ${status}` : text;
}

interface ProxyData {
    status?: number;
    body?: string;
    headers?: Record<string, string>;
}

interface ProxyResponse {
    status: number;
    body: string;
    headers: Record<string, string>;
}

function parseProxyData(response: {code: number; msg: string; data?: unknown}, url: string): ProxyResponse {
    if (response.code !== 0) {
        // 代理自身失败：地址非法、连接被拒、响应超过 32MiB 等
        throw new ApiError(`${response.msg || `forwardProxy failed with code ${response.code}`} (${url})`, false);
    }
    const data = (response.data ?? {}) as ProxyData;
    return {
        status: data.status ?? 0,
        body: typeof data.body === "string" ? data.body : JSON.stringify(data.body ?? ""),
        headers: data.headers ?? {},
    };
}

function buildProxyRequest(api: ApiSettings, timeout: number, extra: Record<string, unknown>) {
    const headers: Record<string, string> = {};
    const apiKey = api.apiKey.trim();
    if (apiKey !== "") {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    return {
        ...extra,
        timeout,
        contentType: "application/json",
        // forwardProxy 要求 headers 是「单键对象数组」，不是普通 map
        headers: Object.entries(headers).map(([name, value]) => ({[name]: value})),
        responseEncoding: "text",
    };
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted) {
            return value;
        }
    }
    return undefined;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 429 等 1s 起指数退避并加抖动；其余可重试错误立即重发。 */
function backoffMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) {
        return Math.min(retryAfterMs, 5000);
    }
    const base = Math.min(1000 * 2 ** attempt, 8000);
    return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * 发一次 chat completions 请求并返回补全文本。
 *
 * 重试与 max_tokens 回退都在本次调用内消化完毕，不跨批次累积。
 * 注意 max_tokens 回退不消耗重试预算，否则等于白白丢掉一次重试机会。
 */
export async function chat(
    params: ChatParams,
    api: ApiSettings,
    behavior: BehaviorSettings,
): Promise<ChatResult> {
    const url = chatCompletionsURL(api.baseURL);
    const maxAttempts = Math.max(1, behavior.retries + 1);
    let useMaxCompletionTokens = true;
    let lastError: ApiError = new ApiError("No attempt was made", false);
    let attempt = 0;

    while (attempt < maxAttempts) {
        let response: ProxyResponse;
        try {
            const payload = buildPayload(params, api, useMaxCompletionTokens);
            debugRequest(url, payload);
            const request = buildProxyRequest(api, behavior.timeout, {
                url,
                method: "POST",
                payload,
                payloadEncoding: "json",
            });
            response = parseProxyData(await fetchSyncPost(PROXY_URL, request), url);
            debugResponse(url, response.status, response.body);
        } catch (error) {
            const apiError = error instanceof ApiError ? error : new ApiError(String(error), true);
            debugError("Request failed", apiError);
            attempt++;
            if (!apiError.retryable || attempt >= maxAttempts) {
                throw apiError;
            }
            const wait = backoffMs(attempt, apiError.retryAfterMs);
            debug(`Retrying in ${wait}ms (attempt ${attempt + 1}/${maxAttempts})`);
            lastError = apiError;
            await sleep(wait);
            continue;
        }

        if (response.status >= 400) {
            const retryAfter = parseRetryAfter(headerValue(response.headers, "retry-after"));
            const message = extractErrorMessage(response.status, response.body);
            const error = new ApiError(`HTTP ${response.status}: ${message}`, false, retryAfter);
            // 408/409/429/5xx 可重试，其余 4xx 是配置或请求本身的问题，重发无意义
            const retryable = response.status === 408 || response.status === 409 ||
                response.status === 429 || response.status >= 500;

            if (useMaxCompletionTokens && response.status === 400 && needsMaxTokensFallback(message)) {
                // 不消耗重试预算：这是供应商字段名差异，不是一次失败尝试
                debug("Provider rejected max_completion_tokens, retrying with max_tokens");
                useMaxCompletionTokens = false;
                continue;
            }

            attempt++;
            if (!retryable || attempt >= maxAttempts) {
                debugError(`Request failed with HTTP ${response.status}`, error);
                throw error;
            }
            const wait = backoffMs(attempt, retryAfter);
            debug(`HTTP ${response.status}, retrying in ${wait}ms (attempt ${attempt + 1}/${maxAttempts})`);
            lastError = error;
            await sleep(wait);
            continue;
        }

        const text = extractContent(response.body);
        debugModelText(text);
        if (text !== "") {
            return {text, reasoning: reasoningTrace(response.body)};
        }
        // 返回体合法但没有文本，多半是推理耗尽了输出预算，重发无意义
        debugError("Response contained no text", response.body.slice(0, 500));
        throw new ApiError(EMPTY_CONTENT, false);
    }

    throw lastError;
}

interface ChatCompletionResponse {
    choices?: {
        message?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
        };
    }[];
    usage?: {
        completion_tokens_details?: {reasoning_tokens?: number};
    };
}

/**
 * 这次响应里模型是否仍然产生了推理。
 *
 * 「请求成功、结果也解析得出来」不等于「禁用思考生效了」：供应商不认那个字段时
 * 通常会静默忽略，于是用户以为关掉了，实际每次都在为一个用不上的思维链付费和等待。
 * 这是最难自查的一类失败，所以两条线索都查：
 * DeepSeek 等把思维链放在 message.reasoning_content，
 * OpenAI 则在 usage.completion_tokens_details.reasoning_tokens 里报数。
 */
export function reasoningTrace(body: string): ReasoningTrace | undefined {
    let parsed: ChatCompletionResponse;
    try {
        parsed = JSON.parse(body) as ChatCompletionResponse;
    } catch {
        // 走到这里说明 extractContent 已经抛过了，这里只是防御
        return undefined;
    }

    const message = parsed.choices?.[0]?.message;
    const text = [message?.reasoning_content, message?.reasoning]
        .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "")
        ?.trim() ?? "";

    const reported = parsed.usage?.completion_tokens_details?.reasoning_tokens;
    const tokens = typeof reported === "number" && reported > 0 ? reported : undefined;

    return text === "" && tokens === undefined ? undefined : {text, tokens};
}

/**
 * 取补全文本。content 为空时回退到推理字段：
 * 部分推理模型的全部输出会落在 reasoning_content / reasoning 里，content 保持为空。
 */
export function extractContent(body: string): string {
    let parsed: ChatCompletionResponse;
    try {
        parsed = JSON.parse(body) as ChatCompletionResponse;
    } catch {
        throw new ApiError(`Response is not valid JSON: ${body.trim().slice(0, 300)}`, false);
    }

    const message = parsed.choices?.[0]?.message;
    if (!message) {
        throw new ApiError("Response contains no choices", false);
    }
    for (const candidate of [message.content, message.reasoning_content, message.reasoning]) {
        if (typeof candidate === "string" && candidate.trim() !== "") {
            return candidate.trim();
        }
    }
    return "";
}

/** 拉取供应商的模型列表，用于设置页的「获取模型列表」。 */
export async function listModels(api: ApiSettings, timeout: number): Promise<string[]> {
    const url = modelsURL(api.baseURL);
    const request = buildProxyRequest(api, timeout, {url, method: "GET"});
    const response = parseProxyData(await fetchSyncPost(PROXY_URL, request), url);
    if (response.status >= 400) {
        throw new Error(`HTTP ${response.status}: ${extractErrorMessage(response.status, response.body)}`);
    }

    let parsed: {data?: {id?: string}[]};
    try {
        parsed = JSON.parse(response.body) as {data?: {id?: string}[]};
    } catch {
        throw new Error(`Response is not valid JSON: ${response.body.trim().slice(0, 200)}`);
    }
    // 兼容服务可能不实现 /models，或省略 id 字段
    return (parsed.data ?? [])
        .map((item) => item.id)
        .filter((id): id is string => typeof id === "string" && id !== "");
}

/**
 * 测试连接：让模型回一个 "hi"，只要拿得到文本就算通过。
 * 返回耗时毫秒数，提示文案由 UI 层拼装。
 */
export async function testConnection(api: ApiSettings, behavior: BehaviorSettings): Promise<{reply: string; elapsed: number}> {
    const started = Date.now();
    const result = await chat(
        {
            system: "You are a connectivity check. Reply with exactly: hi",
            user: "hi",
        },
        {
            ...api,
            // 测试不注入思考参数，避免把「参数不被支持」误判成「连不上」
            suppressReasoning: false,
            maxTokens: 16,
        },
        // 测试连接不重试，让问题立刻暴露
        {...behavior, retries: 0},
    );
    return {reply: result.text.slice(0, 40), elapsed: Date.now() - started};
}

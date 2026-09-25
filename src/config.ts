/**
 * 插件配置的类型定义、默认值与持久化读写。
 *
 * 配置分三组，与设置页的三个分区一一对应：接口、行为、界面。
 * 所有字段都必须有默认值：读回来的配置会与默认值合并，
 * 这样旧版本存下的配置在新增字段后依然可用。
 */

/**
 * 关闭推理的请求体字段。
 *
 * reasoning_effort 是 OpenAI 官方 Chat Completions 的参数本身，不是厂商扩展，
 * 这是它区别于下面那些字段的地方：DeepSeek、Ollama、Gemini 2.5 系、GLM、
 * qwen3.8-max、OpenRouter 都把 "none" 解释为不推理。
 *
 * 但它不是万能钥匙，两点限制写在这里免得后来者再踩：
 * 1. 一贯思考的模型关不掉（Gemini 2.5 Pro / 3 系、qwen3.7-max-preview 之类）；
 * 2. 严格的端点对不认识的参数直接返回 400（OpenAI 官方自己就是，GPT-6 Astra 连
 *    "none" 都拒绝）—— top_k 留空不发是同一个道理。
 */
export const REASONING_EFFORT_FIELD = "reasoning_effort";
export const REASONING_EFFORT_OFF = "none";

/**
 * 已弃用：旧版让用户从一串 JSON 片段里挑一条并入请求体顶层。
 *
 * 撤出界面是因为它没法可靠工作：
 * - `{"extra_body": {...}}` 在原始 HTTP 下**永远不生效**。extra_body 只是 Python SDK
 *   的包装，SDK 会在发送前把它的内容并到请求体顶层；插件直接发 HTTP，供应商只会
 *   看到一个名叫 extra_body 的陌生字段然后静默忽略。用户以为关了思考，实际没关。
 * - 其余几条各只对一个供应商有效，选错时同样没有任何反馈。
 *
 * 代码保留未删（含 client 的 thinkingFields），但新配置不再写入这些字段，
 * 读到旧配置时由 mergeSettings 折算成 suppressReasoning。
 *
 * 每一项都必须是**完整的 JSON 对象文本**：client 拿到后直接 JSON.parse。
 * 更早期版本把这里写成了 `"key": value` 片段，parse 必然抛错，
 * 于是除「不禁用」外每一个预设都会让请求当场失败。
 */
export const THINKING_DISABLED = "disabled";
export const THINKING_CUSTOM = "custom";
export const THINKING_PRESETS = [
    THINKING_DISABLED,
    '{"enable_thinking": false}',
    '{"extra_body": {"enable_thinking": false}}',
    '{"chat_template_kwargs": {"enable_thinking": false}}',
    '{"thinking": {"type": "disabled"}}',
    THINKING_CUSTOM,
] as const;

/** 判断某个取值是否是下拉里的合法预设。 */
function isValidThinkingPreset(value: string): boolean {
    return (THINKING_PRESETS as readonly string[]).includes(value);
}

export const AUTO_APPLY_NEVER = "never";
export const AUTO_APPLY_SINGLE = "single";
export const AUTO_APPLY_ALWAYS = "always";
export const AUTO_APPLY_OPTIONS = [AUTO_APPLY_NEVER, AUTO_APPLY_SINGLE, AUTO_APPLY_ALWAYS] as const;

export type AutoApply = (typeof AUTO_APPLY_OPTIONS)[number];

export const MEDIA_DROP = "drop";
export const MEDIA_PLACEHOLDER = "placeholder";
export const MEDIA_RAW = "raw";
export const MEDIA_OPTIONS = [MEDIA_DROP, MEDIA_PLACEHOLDER, MEDIA_RAW] as const;

/** 正文里链接、图片、音视频与 iframe 的处理方式。 */
export type MediaMode = (typeof MEDIA_OPTIONS)[number];

export const TRUNCATE_HEAD = "head";
export const TRUNCATE_TAIL = "tail";
export const TRUNCATE_BOTH = "both";
export const TRUNCATE_FULL = "full";
export const TRUNCATE_OPTIONS = [TRUNCATE_HEAD, TRUNCATE_TAIL, TRUNCATE_BOTH, TRUNCATE_FULL] as const;

/** 正文超出长度上限时的截取方式。 */
export type TruncateMode = (typeof TRUNCATE_OPTIONS)[number];

export interface ApiSettings {
    /** 协议。当前仅实现 "openai"（Chat Completions），预留扩展 Responses API。 */
    protocol: string;
    baseURL: string;
    apiKey: string;
    model: string;
    /** 关闭推理：开启后请求体带上 reasoning_effort: "none"。 */
    suppressReasoning: boolean;
    /** @deprecated 旧版的 JSON 片段下拉取值，已撤出界面，仅用于读旧配置。 */
    disableThinking: string;
    /** @deprecated 配合 disableThinking 的自定义 JSON，已撤出界面。 */
    customThinking: string;
    temperature: number;
    /** 留空表示不发送 top_p。 */
    topP: number | null;
    /** 留空表示不发送 top_k —— OpenAI 官方接口会直接拒绝未知参数。 */
    topK: number | null;
    maxTokens: number;
}

export interface BehaviorSettings {
    /** 单次 API 请求超时，毫秒。 */
    timeout: number;
    retries: number;
    /** 单篇笔记传入的最大字符数，超出则丢尾部。 */
    contentLimit: number;
    /** 超出长度上限时的截取方式。 */
    truncateMode: TruncateMode;
    /** 「开头 + 末尾」时开头所占比例，0 到 1。 */
    truncateHeadRatio: number;
    /** 链接、图片、音视频与 iframe 的处理方式。 */
    mediaMode: MediaMode;
    /** 是否把文档当前标题一并传入（正文与目录各加一行 H1）。 */
    includeTitle: boolean;
    /** 单次请求最多传入几篇笔记。 */
    batchSize: number;
    /** 同时在飞的请求数上限。 */
    concurrency: number;
    autoApply: AutoApply;
    titleLanguage: string;
    titleStyle: string;
    systemPrompt: string;
    userPrompt: string;
}

export interface UiSettings {
    showTopBar: boolean;
    showBreadcrumb: boolean;
    showDocTreeMenu: boolean;
    /** 开启后在 console 输出完整对话与流程日志，便于排查配置问题。 */
    debug: boolean;
}

export interface PluginSettings {
    api: ApiSettings;
    behavior: BehaviorSettings;
    ui: UiSettings;
}

export const STORAGE_NAME = "settings";

/**
 * 系统提示词只有硬性规定：返回格式、id 对应关系、标题形态。
 * 风格与语言偏好放在用户提示词里。
 */
export const DEFAULT_SYSTEM_PROMPT = `You are a note title generator. Given one or more notes, produce a concise, accurate title for each.

Return ONLY a valid JSON object mapping each note id to its title.

Example:
{
  "id-1": "Title 1",
  "id-2": "Title 2"
}

Rules:
- Use the exact note id string as each key, verbatim.
- Return exactly one entry per note provided.
- The title must be plain text, no markdown, no surrounding quotes.
- Never invent, translate, or alter a note id.
- Output the raw JSON object only. No markdown fences, no explanation, no text before or after.`;

export const DEFAULT_USER_PROMPT = `Generate a title for each of the following notes, one title per note, following the instructions in the system prompt. Return a valid JSON object.

Language: {{language}}
Style: {{style}}

{{content}}`;

export const DEFAULT_SETTINGS: PluginSettings = {
    api: {
        protocol: "openai",
        baseURL: "",
        apiKey: "",
        model: "",
        suppressReasoning: false,
        disableThinking: THINKING_DISABLED,
        customThinking: "",
        temperature: 1.0,
        topP: 0.8,
        topK: null,
        maxTokens: 512,
    },
    behavior: {
        timeout: 10000,
        retries: 1,
        contentLimit: 1000,
        truncateMode: TRUNCATE_HEAD,
        truncateHeadRatio: 0.5,
        mediaMode: MEDIA_PLACEHOLDER,
        includeTitle: true,
        batchSize: 3,
        concurrency: 3,
        autoApply: AUTO_APPLY_NEVER,
        titleLanguage: "中文",
        titleStyle: "简洁准确，拒绝套话",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        userPrompt: DEFAULT_USER_PROMPT,
    },
    ui: {
        showTopBar: true,
        showBreadcrumb: false,
        showDocTreeMenu: true,
        debug: false,
    },
};

/** 思源界面语言码（BCP 47）到标题语言的映射，仅覆盖中文变体，其余用英文。 */
export function defaultTitleLanguage(lang: string): string {
    return lang === "zh-CN" || lang === "zh-TW" ? "中文" : "English";
}

/**
 * 把存下来的配置合并到默认值之上。
 * 逐组合并，缺失字段回退默认值，避免旧配置在新版本下出现 undefined。
 */
export function mergeSettings(stored: unknown): PluginSettings {
    if (!stored || typeof stored !== "object") {
        return structuredClone(DEFAULT_SETTINGS);
    }
    const raw = stored as Partial<PluginSettings>;
    const api = {...DEFAULT_SETTINGS.api, ...(raw.api ?? {})};
    // 旧下拉已撤出界面并弃用，这里把旧字段一律清掉 —— 弃用意味着不再发送，
    // 而不是留着它继续拼进请求体（那些字段要么永远不生效，要么只对一个供应商有效，
    // 具体见 THINKING_PRESETS 的注释）。用户本来「想关掉思考」的意图折算进新开关，
    // 只在没存过 suppressReasoning 时推导一次，之后以新界面上的选择为准。
    if (typeof (raw.api as Partial<ApiSettings> | undefined)?.suppressReasoning !== "boolean") {
        // 更早期版本存的是 `"key": value` 片段，那种解析不了，按「不禁用」处理
        api.suppressReasoning = isValidThinkingPreset(api.disableThinking) &&
            api.disableThinking !== THINKING_DISABLED;
    }
    api.disableThinking = DEFAULT_SETTINGS.api.disableThinking;
    api.customThinking = "";
    return {
        api,
        behavior: {...DEFAULT_SETTINGS.behavior, ...(raw.behavior ?? {})},
        ui: {...DEFAULT_SETTINGS.ui, ...(raw.ui ?? {})},
    };
}

/** 必填项是否齐全，用于在发请求前给出一致的提示。 */
export function hasProviderConfig(api: ApiSettings): boolean {
    return api.baseURL.trim() !== "" && api.model.trim() !== "";
}

export function chatCompletionsURL(baseURL: string): string {
    return `${baseURL.trim().replace(/\/+$/, "")}/chat/completions`;
}

export function modelsURL(baseURL: string): string {
    return `${baseURL.trim().replace(/\/+$/, "")}/models`;
}

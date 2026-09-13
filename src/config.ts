/**
 * 插件配置的类型定义、默认值与持久化读写。
 *
 * 配置分三组，与设置页的三个分区一一对应：接口、行为、界面。
 * 所有字段都必须有默认值：读回来的配置会与默认值合并，
 * 这样旧版本存下的配置在新增字段后依然可用。
 */

/**
 * 关闭推理过程的请求体附加字段，选中后并入请求体顶层。
 *
 * 每一项都必须是**完整的 JSON 对象文本**：client 拿到后直接 JSON.parse。
 * 早期版本把这里写成了 `"key": value` 片段，parse 必然抛错，
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

export interface ApiSettings {
    /** 协议。当前仅实现 "openai"（Chat Completions），预留扩展 Responses API。 */
    protocol: string;
    baseURL: string;
    apiKey: string;
    model: string;
    /** THINKING_PRESETS 中的一项，或 THINKING_CUSTOM。 */
    disableThinking: string;
    /** 选中 THINKING_CUSTOM 时生效的 JSON 对象文本。 */
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
        disableThinking: THINKING_DISABLED,
        customThinking: "",
        temperature: 1.0,
        topP: 1.0,
        topK: null,
        maxTokens: 512,
    },
    behavior: {
        timeout: 10000,
        retries: 1,
        contentLimit: 4000,
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
    // 早期版本在这里存的是 JSON 片段，已经发不出去，回落到「不禁用」而不是让它继续报错
    if (!isValidThinkingPreset(api.disableThinking)) {
        api.disableThinking = DEFAULT_SETTINGS.api.disableThinking;
    }
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

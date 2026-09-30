import {describe, expect, it} from "vitest";
import {
    DEFAULT_SETTINGS,
    defaultTitleLanguage,
    hasProviderConfig,
    isProtocol,
    mergeSettings,
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_CHAT_COMPLETIONS,
    PROTOCOL_RESPONSES,
    REASONING_DEFAULT,
    REASONING_EFFORT_OFF,
} from "../src/config";

describe("mergeSettings（旧配置兼容）", () => {
    it("什么都没存时给出默认值", () => {
        expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
        expect(mergeSettings("not an object")).toEqual(DEFAULT_SETTINGS);
    });

    it("缺字段的旧配置逐项回退默认值", () => {
        const merged = mergeSettings({api: {baseURL: "https://example.com/v1"}});
        expect(merged.api.baseURL).toBe("https://example.com/v1");
        expect(merged.api.model).toBe(DEFAULT_SETTINGS.api.model);
        expect(merged.behavior.batchSize).toBe(DEFAULT_SETTINGS.behavior.batchSize);
        expect(merged.ui.debug).toBe(false);
    });

    it("三个协议都保留，认不出来的取值退回 Chat Completions（#8 #20）", () => {
        for (const protocol of [PROTOCOL_CHAT_COMPLETIONS, PROTOCOL_RESPONSES, PROTOCOL_ANTHROPIC_MESSAGES]) {
            expect(mergeSettings({api: {protocol}}).api.protocol).toBe(protocol);
        }
        expect(mergeSettings({api: {protocol: "gemini"}}).api.protocol).toBe(PROTOCOL_CHAT_COMPLETIONS);
        expect(mergeSettings({api: {}}).api.protocol).toBe(PROTOCOL_CHAT_COMPLETIONS);
        expect(isProtocol("anthropic-messages")).toBe(true);
        expect(isProtocol("anthropic")).toBe(false);
    });

    it("已弃用的「禁用思考」下拉一律清掉，不再拼进请求体（#14）", () => {
        const merged = mergeSettings({
            api: {disableThinking: '{"enable_thinking": false}', customThinking: '{"thinking": {"type": "disabled"}}'},
        });
        expect(merged.api.disableThinking).toBe(DEFAULT_SETTINGS.api.disableThinking);
        expect(merged.api.customThinking).toBe("");
    });

    it("旧开关折算成思考强度的禁用档，之后以新配置为准", () => {
        expect(mergeSettings({api: {suppressReasoning: true}}).api.reasoningEffort).toBe(REASONING_EFFORT_OFF);
        expect(mergeSettings({api: {disableThinking: "disabled"}}).api.reasoningEffort).toBe(REASONING_DEFAULT);
        // 已经存过 reasoningEffort 时不再回头看旧字段
        expect(mergeSettings({api: {reasoningEffort: "high", suppressReasoning: true}}).api.reasoningEffort).toBe("high");
        expect(mergeSettings({api: {}}).api.reasoningEffort).toBe(REASONING_DEFAULT);
    });

    it("自定义请求头默认留空，存的不是文本时按空处理（#24）", () => {
        expect(DEFAULT_SETTINGS.api.customHeaders).toBe("");
        expect(mergeSettings({api: {baseURL: "https://example.com/v1"}}).api.customHeaders).toBe("");
        expect(mergeSettings({api: {customHeaders: '{"X-Route": "a"}'}}).api.customHeaders).toBe('{"X-Route": "a"}');
        // 手改成对象/数组时不留着：留着只会在第一次解析时炸成看不懂的报错
        expect(mergeSettings({api: {customHeaders: {"X-Route": "a"}}}).api.customHeaders).toBe("");
    });

    it("注入防护默认开启，旧配置缺这个字段时也按开启处理（#23）", () => {
        expect(DEFAULT_SETTINGS.behavior.ignoreInjection).toBe(true);
        expect(mergeSettings(undefined).behavior.ignoreInjection).toBe(true);
        expect(mergeSettings({behavior: {batchSize: 5}}).behavior.ignoreInjection).toBe(true);
        expect(mergeSettings({behavior: {ignoreInjection: false}}).behavior.ignoreInjection).toBe(false);
    });

    it("旧版可改写的完整提示词被删掉，只留追加位（#5）", () => {
        const merged = mergeSettings({
            behavior: {systemPrompt: "被改坏的提示词", userPrompt: "同样被改坏"},
        });
        const behavior = merged.behavior as unknown as Record<string, unknown>;
        expect(behavior.systemPrompt).toBeUndefined();
        expect(behavior.userPrompt).toBeUndefined();
        expect(merged.behavior.systemExtra).toBe("");
    });
});

describe("defaultTitleLanguage（#21 标题语言跟随界面）", () => {
    it("中文变体给中文，其余给英文", () => {
        expect(defaultTitleLanguage("zh-CN")).toBe("中文");
        expect(defaultTitleLanguage("zh-TW")).toBe("中文");
        expect(defaultTitleLanguage("en-US")).toBe("English");
        expect(defaultTitleLanguage("ja-JP")).toBe("English");
    });
});

describe("hasProviderConfig", () => {
    it("地址和模型都填了才算配置好", () => {
        const api = {...DEFAULT_SETTINGS.api, baseURL: "https://example.com/v1", model: "gpt-5.1"};
        expect(hasProviderConfig(api)).toBe(true);
        expect(hasProviderConfig({...api, model: "  "})).toBe(false);
        expect(hasProviderConfig({...api, baseURL: ""})).toBe(false);
    });
});

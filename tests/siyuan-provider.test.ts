import {afterEach, describe, expect, it} from "vitest";
import {ApiError} from "../src/api/protocol";
import {
    activeModelName,
    providerModelNames,
    providerProtocol,
    readSiyuanProviders,
    resolveApiSettings,
} from "../src/api/siyuan-provider";
import {
    type ApiSettings,
    DEFAULT_SETTINGS,
    PROTOCOL_CHAT_COMPLETIONS,
    PROTOCOL_SIYUAN_PROVIDER,
} from "../src/config";

/** 思源「设置 → AI → 供应商」里的一条配置，字段取自内核的 conf.Provider。 */
const PROVIDER = {
    id: "20260913135841-1u2j84c",
    displayName: "Example",
    enabled: true,
    baseURL: "https://api.example.com/v1",
    apiKey: "sk-from-siyuan",
    protocol: "openai-responses",
    headers: {"x-opencode-session": "{{vars.SESSION}}"},
    models: [
        {id: "20260913135841-m1", name: "gpt-5.1", enabled: false},
        {id: "20260913135841-m2", name: "gpt-5.2", enabled: true},
    ],
};

/** 装一份假的宿主配置：真实环境里就是 window.siyuan.config。 */
function setProviders(providers: unknown[]): void {
    (globalThis as unknown as {window?: unknown}).window = {siyuan: {config: {ai: {providers}}}};
}

/** 「使用思源设置中供应商」模式下的一份插件配置。 */
function siyuanApi(overrides: Partial<ApiSettings> = {}): ApiSettings {
    return {
        ...DEFAULT_SETTINGS.api,
        protocol: PROTOCOL_SIYUAN_PROVIDER,
        siyuanProvider: PROVIDER.id,
        model: "",
        ...overrides,
    };
}

afterEach(() => {
    delete (globalThis as unknown as {window?: unknown}).window;
});

describe("resolveApiSettings（#27 使用思源设置中供应商）", () => {
    it("自定义配置原样返回，只做类型收窄", () => {
        setProviders([]);
        const api: ApiSettings = {
            ...DEFAULT_SETTINGS.api,
            protocol: PROTOCOL_CHAT_COMPLETIONS,
            baseURL: "https://api.openai.com/v1",
            apiKey: "sk-mine",
            customHeaders: '{"X-Route": "a"}',
            model: "gpt-5.1",
        };
        expect(resolveApiSettings(api)).toEqual(api);
    });

    it("协议、Base URL、密钥与请求头整条换成供应商那一份，模型留空时用启用中的那个", () => {
        setProviders([PROVIDER]);
        const resolved = resolveApiSettings(siyuanApi());
        expect(resolved.protocol).toBe("openai-responses");
        expect(resolved.baseURL).toBe("https://api.example.com/v1");
        expect(resolved.apiKey).toBe("sk-from-siyuan");
        expect(JSON.parse(resolved.customHeaders)).toEqual({"x-opencode-session": "{{vars.SESSION}}"});
        // 模型名必须取 name：思源给模型另生成的内部 id 发到接口上取不到模型
        expect(resolved.model).toBe("gpt-5.2");
    });

    it("已经选过模型时以插件里的为准", () => {
        setProviders([PROVIDER]);
        expect(resolveApiSettings(siyuanApi({model: "gpt-5.1"})).model).toBe("gpt-5.1");
    });

    it("供应商没配请求头时按「没有自定义请求头」处理", () => {
        setProviders([{...PROVIDER, headers: {}}]);
        expect(resolveApiSettings(siyuanApi()).customHeaders).toBe("");
    });

    it("供应商没标协议时按思源自己的默认值 Chat Completions", () => {
        setProviders([{...PROVIDER, protocol: ""}]);
        expect(resolveApiSettings(siyuanApi()).protocol).toBe(PROTOCOL_CHAT_COMPLETIONS);
    });

    it("没选供应商时当场报错，不发一个没有鉴权的请求", () => {
        setProviders([PROVIDER]);
        expect(() => resolveApiSettings(siyuanApi({siyuanProvider: "  "}))).toThrow(/No SiYuan provider is selected/);
    });

    it("供应商不存在（思源那边删了，或当前角色读不到）时报出它的 id", () => {
        setProviders([]);
        const failure = (() => {
            try {
                resolveApiSettings(siyuanApi());
                return undefined;
            } catch (error) {
                return error;
            }
        })();
        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as Error).message).toContain(PROVIDER.id);
    });

    it("供应商的协议插件没实现时拒绝发请求", () => {
        setProviders([{...PROVIDER, protocol: "gemini"}]);
        expect(() => resolveApiSettings(siyuanApi())).toThrow(/does not implement/);
    });

    it("供应商没填 Base URL 时说清楚去哪儿补", () => {
        setProviders([{...PROVIDER, baseURL: "   "}]);
        expect(() => resolveApiSettings(siyuanApi())).toThrow(/has no base URL/);
    });
});

describe("供应商配置的读法（#27）", () => {
    it("模型名取 name，启用中的排在前面，空名与重名去掉", () => {
        expect(providerModelNames(PROVIDER)).toEqual(["gpt-5.2", "gpt-5.1"]);
        expect(providerModelNames({models: [{name: "b"}, {name: "a", enabled: true}, {name: "a"}, {name: "  "}]}))
            .toEqual(["a", "b"]);
        expect(providerModelNames({})).toEqual([]);
    });

    it("activeModelName 取启用中的模型，都没有时取第一条", () => {
        expect(activeModelName(PROVIDER)).toBe("gpt-5.2");
        expect(activeModelName({models: [{name: "only"}]})).toBe("only");
        expect(activeModelName({models: []})).toBe("");
    });

    it("协议缺省时按思源的默认值处理，多余空白去掉", () => {
        expect(providerProtocol({})).toBe(PROTOCOL_CHAT_COMPLETIONS);
        expect(providerProtocol({protocol: "  "})).toBe(PROTOCOL_CHAT_COMPLETIONS);
        expect(providerProtocol({protocol: " anthropic-messages "})).toBe("anthropic-messages");
    });

    it("没有宿主配置时读到空列表，而不是抛错", () => {
        expect(readSiyuanProviders()).toEqual([]);
    });
});

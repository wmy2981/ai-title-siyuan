import {afterEach, describe, expect, it} from "vitest";
import {DEFAULT_SETTINGS, type ApiSettings} from "../src/config";
import {parseCustomHeaders, withCustomHeaders} from "../src/api/headers";

const API: ApiSettings = {
    ...DEFAULT_SETTINGS.api,
    baseURL: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "gpt-5.1",
};

/** 带自定义请求头的接口配置。 */
function withHeaders(customHeaders: string, baseURL = API.baseURL): ApiSettings {
    return {...API, baseURL, customHeaders};
}

/**
 * 装一份假的思源配置。真实宿主里就是 `window.siyuan.config`
 * （密钥库与变量库都在这里，非管理员角色下内核会把两者清空）。
 */
function setSiyuanConfig(config: unknown): void {
    (globalThis as unknown as {window: unknown}).window = {siyuan: {config}};
}

afterEach(() => {
    delete (globalThis as unknown as {window?: unknown}).window;
});

describe("parseCustomHeaders（#24 自定义请求头）", () => {
    it("空文本表示没有自定义请求头", () => {
        expect(parseCustomHeaders("")).toEqual({});
        expect(parseCustomHeaders("  \n ")).toEqual({});
    });

    it("解析 JSON 对象，保留原本的大小写与取值", () => {
        expect(parseCustomHeaders('{"X-Route": "a", "authorization": "Bearer k"}'))
            .toEqual({"X-Route": "a", authorization: "Bearer k"});
    });

    it("不是 JSON 对象时报错，且不回显用户填的内容", () => {
        expect(() => parseCustomHeaders('{"X-Route": "a"')).toThrow(/not valid JSON/);
        expect(() => parseCustomHeaders('["a"]')).toThrow(/must be a JSON object/);
        expect(() => parseCustomHeaders('"Bearer sk-secret"')).toThrow(/must be a JSON object/);
        let message = "";
        try {
            parseCustomHeaders('{"X-Secret": "sk-secret"');
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toContain("not valid JSON");
        expect(message).not.toContain("sk-secret");
    });

    it("拒绝非法名字、大小写重复与非字符串取值（与思源同一条规则）", () => {
        expect(() => parseCustomHeaders('{"Bad Name": "a"}')).toThrow(/Invalid custom request header name: Bad Name/);
        expect(() => parseCustomHeaders('{"X-Test": "a", "x-test": "b"}')).toThrow(/Duplicate custom request header: x-test/);
        expect(() => parseCustomHeaders('{"X-Test": 1}')).toThrow(/must have a string value/);
        expect(() => parseCustomHeaders('{"X-Test": {"nested": "a"}}')).toThrow(/must have a string value/);
    });

    it("思源供应商的请求头照原样写成文本框，也照原样解析回来", () => {
        // 「从思源设置获取」把供应商的 headers 用 JSON.stringify(headers, null, 2) 写进设置页，
        // 这里钉住这条往返：导入的文本必须能通过校验，且取值里的占位符一字不改
        const providerHeaders = {
            "x-opencode-session": "{{vars.OPENCODE_GO_SESSION}}",
            "User-Agent": "my-agent/1.0",
            Authorization: "Bearer {{secrets.OPENCODE_KEY}}",
        };
        expect(parseCustomHeaders(JSON.stringify(providerHeaders, null, 2))).toEqual(providerHeaders);
        // 供应商没配请求头时文本框留空，等于没有自定义请求头
        expect(parseCustomHeaders("")).toEqual({});
    });
});

describe("withCustomHeaders（#24 变量与密钥在每次请求前解析）", () => {
    it("变量按名字替换，密钥只在允许主机里替换", () => {
        setSiyuanConfig({
            variables: {items: [{name: "SESSION", value: "session-1"}]},
            secrets: {items: [{name: "TOKEN", value: "private-token", allowedHosts: ["api.example.com"]}]},
        });
        const headers = withCustomHeaders({}, withHeaders(
            '{"x-opencode-session": "{{vars.SESSION}}", "Authorization": "Bearer {{secrets.TOKEN}}"}',
        ));
        expect(headers).toEqual({
            "x-opencode-session": "session-1",
            Authorization: "Bearer private-token",
        });
    });

    it("密钥的允许主机不含目标域名时保留占位符，变量不受这层限制", () => {
        setSiyuanConfig({
            variables: {items: [{name: "SESSION", value: "session-1"}]},
            secrets: {items: [{name: "TOKEN", value: "private-token", allowedHosts: ["other.example.com"]}]},
        });
        const headers = withCustomHeaders({}, withHeaders(
            '{"Authorization": "Bearer {{secrets.TOKEN}}", "x-session": "{{vars.SESSION}}"}',
        ));
        expect(headers.Authorization).toBe("Bearer {{secrets.TOKEN}}");
        expect(headers["x-session"]).toBe("session-1");
    });

    it("没配过的名字原样保留；没有思源配置（测试或非管理员）时全都保留", () => {
        setSiyuanConfig({variables: {items: []}, secrets: {items: []}});
        expect(withCustomHeaders({}, withHeaders('{"X-A": "{{vars.NOPE}}"}'))).toEqual({"X-A": "{{vars.NOPE}}"});
        delete (globalThis as unknown as {window?: unknown}).window;
        expect(withCustomHeaders({}, withHeaders('{"X-A": "{{secrets.NOPE}}"}'))).toEqual({"X-A": "{{secrets.NOPE}}"});
    });

    it("自定义头覆盖同名的协议头（大小写不敏感）", () => {
        const headers = withCustomHeaders(
            {Authorization: "Bearer sk-test"},
            withHeaders('{"authorization": "Bearer from-header"}'),
        );
        // 只有一项：覆盖而不是并存，否则供应商会收到两个 Authorization
        expect(Object.keys(headers)).toEqual(["authorization"]);
        expect(headers.authorization).toBe("Bearer from-header");
    });

    it("没有自定义头时协议头原样保留", () => {
        expect(withCustomHeaders({Authorization: "Bearer sk-test"}, API)).toEqual({Authorization: "Bearer sk-test"});
    });

    it("解析后的取值带控制字符时报错，且不回显密钥", () => {
        setSiyuanConfig({
            secrets: {items: [{name: "TOKEN", value: "private\r\ninjected: true", allowedHosts: ["api.example.com"]}]},
        });
        let message = "";
        try {
            withCustomHeaders({}, withHeaders('{"Authorization": "Bearer {{secrets.TOKEN}}"}'));
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toContain("control characters");
        expect(message).toContain("Authorization");
        expect(message).not.toContain("injected");
        expect(message).not.toContain("private");
    });
});

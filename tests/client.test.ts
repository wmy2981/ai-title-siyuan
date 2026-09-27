import {beforeEach, describe, expect, it} from "vitest";
import {
    DEFAULT_SETTINGS,
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_RESPONSES,
    type ApiSettings,
    type BehaviorSettings,
} from "../src/config";
import {ApiError, chat, EMPTY_CONTENT, testConnection} from "../src/api/client";
import {setFetchSyncPost} from "./stubs/siyuan";

/** 一次 forwardProxy 调用里插件真正发出去的东西。 */
interface ProxyCall {
    url: string;
    method: string;
    headers: {[name: string]: string}[];
    payload?: Record<string, unknown>;
}

let calls: ProxyCall[] = [];

function reply(status: number, body: string, headers: Record<string, string> = {}): unknown {
    return {code: 0, msg: "", data: {status, body, headers}};
}

/** 按顺序返回准备好的响应，并记下每次实际发出去的请求。 */
function stubReplies(...replies: unknown[]): void {
    let index = 0;
    setFetchSyncPost((_url, data) => {
        calls.push(data as ProxyCall);
        return Promise.resolve(replies[Math.min(index++, replies.length - 1)]);
    });
}

const API: ApiSettings = {
    ...DEFAULT_SETTINGS.api,
    baseURL: "https://api.openai.com/v1",
    apiKey: "sk-test",
    model: "gpt-5.1",
};
const NO_RETRY: BehaviorSettings = {...DEFAULT_SETTINGS.behavior, retries: 0};
const PARAMS = {system: "SYS", user: "USER"};
const OK_BODY = '{"choices":[{"message":{"content":"Title"}}]}';

beforeEach(() => {
    calls = [];
    setFetchSyncPost(() => Promise.reject(new Error("fetchSyncPost was not stubbed for this test")));
});

describe("chat 的请求与响应（#8 #20 的三种协议都走同一条传输路径）", () => {
    it("Chat Completions：发到 /chat/completions，取回文本", async () => {
        stubReplies(reply(200, OK_BODY));
        const result = await chat(PARAMS, API, NO_RETRY);
        expect(result.text).toBe("Title");
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
        expect(calls[0].method).toBe("POST");
        expect(calls[0].headers).toEqual([{Authorization: "Bearer sk-test"}]);
        expect(calls[0].payload?.messages).toEqual([
            {role: "system", content: "SYS"},
            {role: "user", content: "USER"},
        ]);
    });

    it("Responses：发到 /responses 并解析 output（#8）", async () => {
        stubReplies(reply(200, JSON.stringify({
            output: [{type: "message", content: [{type: "output_text", text: "Title"}]}],
        })));
        const result = await chat(PARAMS, {...API, protocol: PROTOCOL_RESPONSES}, NO_RETRY);
        expect(result.text).toBe("Title");
        expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
        expect(calls[0].payload).toHaveProperty("instructions", "SYS");
    });

    it("Messages：发到 /v1/messages 并带上 x-api-key（#20）", async () => {
        stubReplies(reply(200, JSON.stringify({content: [{type: "text", text: "Title"}]})));
        const target: ApiSettings = {...API, protocol: PROTOCOL_ANTHROPIC_MESSAGES, baseURL: "https://api.anthropic.com/v1"};
        const result = await chat(PARAMS, target, NO_RETRY);
        expect(result.text).toBe("Title");
        expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
        expect(calls[0].headers).toEqual([{"anthropic-version": "2023-06-01"}, {"x-api-key": "sk-test"}]);
        expect(calls[0].payload).toHaveProperty("max_tokens");
    });

    it("供应商拒绝 max_completion_tokens 时自动改名重发，且不消耗重试预算", async () => {
        stubReplies(
            reply(400, '{"error":{"message":"Unsupported parameter: max_completion_tokens"}}'),
            reply(200, OK_BODY),
        );
        const result = await chat(PARAMS, {...API, maxTokens: 256}, NO_RETRY);
        expect(result.text).toBe("Title");
        expect(calls).toHaveLength(2);
        expect(calls[0].payload).toHaveProperty("max_completion_tokens", 256);
        expect(calls[1].payload).toHaveProperty("max_tokens", 256);
    });

    it("限流按响应里的 retry-after 重试", async () => {
        stubReplies(reply(429, "slow down", {"Retry-After": "0"}), reply(200, OK_BODY));
        const result = await chat(PARAMS, API, {...NO_RETRY, retries: 1});
        expect(result.text).toBe("Title");
        expect(calls).toHaveLength(2);
    });

    it("配置类错误立即抛出，不做无意义的重发", async () => {
        stubReplies(reply(400, '{"error":{"message":"bad model"}}'));
        await expect(chat(PARAMS, API, {...NO_RETRY, retries: 3})).rejects.toThrow(/HTTP 400: bad model/);
        expect(calls).toHaveLength(1);
    });

    it("响应合法但没有文本时给出 EMPTY_CONTENT 哨兵", async () => {
        stubReplies(reply(200, '{"choices":[{"message":{"content":""}}]}'));
        await expect(chat(PARAMS, API, NO_RETRY)).rejects.toThrow(EMPTY_CONTENT);
    });

    it("代理自身失败（地址非法、连接被拒）直接抛出", async () => {
        setFetchSyncPost(() => Promise.resolve({code: 1, msg: "connect: connection refused"}));
        await expect(chat(PARAMS, API, NO_RETRY)).rejects.toThrow(/connection refused/);
    });

    it("错误响应里的原文与状态码都带上", async () => {
        stubReplies(reply(500, "<html>bad gateway</html>"));
        const failure = await chat(PARAMS, API, NO_RETRY).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as Error).message).toContain("HTTP 500");
        expect((failure as Error).message).toContain("bad gateway");
    });

    it("测试连接按当前协议发一次请求并回报耗时", async () => {
        stubReplies(reply(200, '{"choices":[{"message":{"content":"hi"}}]}'));
        const result = await testConnection(API, NO_RETRY);
        expect(result.reply).toBe("hi");
        expect(result.elapsed).toBeGreaterThanOrEqual(0);
    });
});

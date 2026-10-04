import {beforeEach, describe, expect, it} from "vitest";
import {DEFAULT_SETTINGS, PROTOCOL_SIYUAN_PROVIDER, type PluginSettings} from "../src/config";
import {loadProviderSelection, saveProviderSelection, withoutProviderSelection} from "../src/device-store";
import {setFetchSyncPost} from "./stubs/siyuan";

/** 记录每次内核调用，便于断言用的是哪个端点、发了什么。 */
interface Call {
    url: string;
    data: Record<string, unknown>;
}

let calls: Call[] = [];

function stub(response: unknown): void {
    setFetchSyncPost((url, data) => {
        calls.push({url, data: (data ?? {}) as Record<string, unknown>});
        return Promise.resolve(response);
    });
}

/** 一份带「本设备供应商选择」的配置。 */
function settings(overrides: Partial<PluginSettings["api"]> = {}): PluginSettings {
    return {
        ...structuredClone(DEFAULT_SETTINGS),
        api: {
            ...DEFAULT_SETTINGS.api,
            protocol: PROTOCOL_SIYUAN_PROVIDER,
            siyuanProvider: "20260913135841-1u2j84c",
            siyuanModel: "gpt-5.2",
            ...overrides,
        },
    };
}

beforeEach(() => {
    calls = [];
    setFetchSyncPost(() => Promise.reject(new Error("fetchSyncPost was not stubbed for this test")));
});

describe("每设备的供应商选择（#27 不参与数据同步）", () => {
    it("读的是内核 local storage，键名带插件名前缀", async () => {
        stub({code: 0, msg: "", data: {provider: "p1", model: "gpt-5.1"}});
        await expect(loadProviderSelection()).resolves.toEqual({provider: "p1", model: "gpt-5.1"});
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("/api/storage/getLocalStorageVal");
        expect(calls[0].data.key).toBe("ai-title-siyuan-provider");
    });

    it("写的是内核 local storage，值就是这一对", async () => {
        stub({code: 0, msg: "", data: null});
        await saveProviderSelection({provider: "p1", model: "gpt-5.1"});
        expect(calls[0].url).toBe("/api/storage/setLocalStorageVal");
        expect(calls[0].data).toEqual({
            key: "ai-title-siyuan-provider",
            val: {provider: "p1", model: "gpt-5.1"},
        });
    });

    it("没存过（data 为 null）时返回 undefined，而不是一对空串", async () => {
        stub({code: 0, msg: "", data: null});
        await expect(loadProviderSelection()).resolves.toBeUndefined();
    });

    it("值被手改坏时按缺字段处理，不抛错", async () => {
        stub({code: 0, msg: "", data: {provider: 42, model: "gpt-5.1"}});
        await expect(loadProviderSelection()).resolves.toEqual({provider: "", model: "gpt-5.1"});
        stub({code: 0, msg: "", data: "not an object"});
        await expect(loadProviderSelection()).resolves.toBeUndefined();
    });

    it("内核报错或调用失败时返回 undefined，不拦住插件加载", async () => {
        stub({code: -1, msg: "nope"});
        await expect(loadProviderSelection()).resolves.toBeUndefined();
        setFetchSyncPost(() => Promise.reject(new Error("boom")));
        await expect(loadProviderSelection()).resolves.toBeUndefined();
        // 写失败同样只记日志
        await expect(saveProviderSelection({provider: "p1", model: "m"})).resolves.toBeUndefined();
    });

    it("落盘用的配置里这两项被清空，其余原样", () => {
        const synced = withoutProviderSelection(settings());
        expect(synced.api.siyuanProvider).toBe("");
        expect(synced.api.siyuanModel).toBe("");
        // 其余字段一个都不能动：它们仍然要同步
        expect(synced.api.baseURL).toBe(DEFAULT_SETTINGS.api.baseURL);
        expect(synced.api.temperature).toBe(DEFAULT_SETTINGS.api.temperature);
        expect(synced.behavior.batchSize).toBe(DEFAULT_SETTINGS.behavior.batchSize);
        // 原对象不能被改：调用方还在用它
        expect(settings().api.siyuanProvider).toBe("20260913135841-1u2j84c");
    });
});

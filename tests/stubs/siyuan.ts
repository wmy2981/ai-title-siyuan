/**
 * 测试用的 siyuan 存根。
 *
 * SDK 只发布类型，运行时符号由思源在加载插件时注入，所以测试里必须自己给一份。
 * 默认的 fetchSyncPost 直接失败：测试只覆盖不碰宿主的纯逻辑，
 * 真要调用内核时应当显式装上假实现（见 tests/client.test.ts），
 * 而不是让一个返回空数据的默认值把断言悄悄放过。
 */
export type FetchSyncPost = (url: string, data?: unknown) => Promise<unknown>;

let handler: FetchSyncPost = () => Promise.reject(new Error("fetchSyncPost was not stubbed for this test"));

/** 装上本次测试要用的假实现。 */
export function setFetchSyncPost(next: FetchSyncPost): void {
    handler = next;
}

export function fetchSyncPost(url: string, data?: unknown): Promise<unknown> {
    return handler(url, data);
}

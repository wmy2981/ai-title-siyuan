import {fileURLToPath} from "node:url";
import {defineConfig} from "vitest/config";

// 单元测试只覆盖纯逻辑：协议请求体与响应解析、正文截取、提示词渲染、配置合并、文案表。
// 需要内核接口的路径（导出正文、改标题）留给人工在思源里验证。
//
// siyuan 包只发布类型（siyuan.d.ts），运行时符号由宿主在加载插件时注入，
// 所以 Node 里 import "siyuan" 必然解析失败 —— 测试时把它别名到本地存根，
// 存根里还能挂上假的 fetchSyncPost，用来验证 chat() 的重试与回退。
export default defineConfig({
    resolve: {
        alias: [
            {find: /^siyuan$/, replacement: fileURLToPath(new URL("./tests/stubs/siyuan.ts", import.meta.url))},
        ],
    },
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
    },
});

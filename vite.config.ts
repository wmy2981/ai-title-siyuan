import {defineConfig} from "vite";

// 思源插件入口固定为包内根目录的 index.js，CSS 固定为 index.css；
// siyuan 模块由宿主在运行时注入，必须保持 external。
//
// 产物必须是 CommonJS，不能是 ESM：宿主在 app/src/plugin/loader.ts 里把插件代码
// 包进 (function anonymous(require, module, exports){...}) 再 window.eval，
// require("siyuan") 由它注入。输出 ESM 会在第一行 import 处直接抛
// SyntaxError: Cannot use import statement outside a module。
export default defineConfig(({mode}) => ({
    build: {
        outDir: "dist",
        emptyOutDir: true,
        // 开发模式保留可读代码，生产模式由 esbuild 压缩
        minify: mode === "production",
        sourcemap: mode !== "production",
        lib: {
            entry: "src/index.ts",
            formats: ["cjs"],
            fileName: () => "index.js",
            cssFileName: "index",
        },
        rollupOptions: {
            external: ["siyuan"],
        },
    },
}));

import {defineConfig} from "vite";

// 思源插件入口固定为包内根目录的 index.js，CSS 固定为 index.css；
// siyuan 模块由宿主在运行时注入，必须保持 external。
export default defineConfig(({mode}) => ({
    build: {
        outDir: "dist",
        emptyOutDir: true,
        // 开发模式保留可读代码，生产模式由 esbuild 压缩
        minify: mode === "production",
        sourcemap: mode !== "production",
        lib: {
            entry: "src/index.ts",
            formats: ["es"],
            fileName: () => "index.js",
            cssFileName: "index",
        },
        rollupOptions: {
            external: ["siyuan"],
        },
    },
}));

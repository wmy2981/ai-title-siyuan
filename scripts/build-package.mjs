// 把 Vite 产物补全为可安装的插件包，并压成仓库根目录的 package.zip。
// 包内结构（cd.yml 上传的就是这个 zip）：
//   index.js  index.css  plugin.json  icon.png  preview.png  README*.md  i18n/
import {createWriteStream, existsSync, rmSync} from "node:fs";
import {cp, stat} from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";

const root = process.cwd();
const dist = path.join(root, "dist");

// 源文件在 assets/ 下，但插件包内必须是根目录的 icon.png / preview.png，
// 否则思源按 plugin.json 的引用找不到文件。
// README 用插件包内的下划线命名，与 plugin.json 的 readme 字段一致。
const entries = [
    ["plugin.json", "plugin.json"],
    ["assets/icon.png", "icon.png"],
    ["assets/preview.png", "preview.png"],
    ["README.md", "README.md"],
    ["README.zh-CN.md", "README_zh_CN.md"],
    ["LICENSE", "LICENSE"],
    ["src/i18n", "i18n"],
];

for (const [from, to] of entries) {
    const source = path.join(root, from);
    if (!existsSync(source)) {
        // 文档类文件在写完之前尚不存在，缺失只提示不中断
        console.warn(`skip missing: ${from}`);
        continue;
    }
    await cp(source, path.join(dist, to), {recursive: true});
}

const zipPath = path.join(root, "package.zip");
rmSync(zipPath, {force: true});

await new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", {zlib: {level: 9}});
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(dist, false);
    archive.finalize();
});

const {size} = await stat(zipPath);
console.log(`package.zip done: ${size} bytes`);

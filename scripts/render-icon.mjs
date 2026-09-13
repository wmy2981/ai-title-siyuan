// 把 assets/icon.svg 渲染成 160x160 的插件图标。
//
// 160x160 是思源集市建议尺寸，上限 20KiB。先按 4 倍密度栅格化再缩放，
// 边缘比直接栅格化到目标尺寸更锐利。
//
// 软件内显示的图标不走这里：它以 24x24 内联在 src/icons.ts 里，
// 由 addIcons 注入，不随插件包分发文件。
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
const source = path.join(assets, "icon.svg");
const target = path.join(assets, "icon.png");

await sharp(fs.readFileSync(source), {density: 384})
    .resize(160, 160)
    .png({compressionLevel: 9})
    .toFile(target);

console.log(`assets/icon.png done: ${fs.statSync(target).size} bytes (160x160)`);

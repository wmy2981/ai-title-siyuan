// 把 assets/preview.html 的 Chrome 截图压缩到集市上限以内。
//
// preview.png 由 Chrome 按 assets/preview.html 的 body 尺寸截图生成（见 README 的开发说明），
// 直接截出来的图 190KiB 上下，贴着集市 200KiB 的上限。
// 这张图是扁平配色的特性宣传图，调色板量化几乎无损，能把体积压到 1/5。
//
// 目标分辨率不写死在这里，而是从 HTML 的 body 尺寸读出来：
// 截图分辨率一旦调整，两者不会悄悄对不上。
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(root, "assets", "preview.html");
const pngPath = path.join(root, "assets", "preview.png");

if (!fs.existsSync(pngPath)) {
    console.error(`assets/preview.png not found. Screenshot assets/preview.html first (see README).`);
    process.exit(1);
}

const html = fs.readFileSync(htmlPath, "utf8");
const width = /body\s*\{[^}]*?width:\s*(\d+)px/s.exec(html)?.[1];
const height = /body\s*\{[^}]*?height:\s*(\d+)px/s.exec(html)?.[1];

const image = sharp(pngPath);
const metadata = await image.metadata();

if (width && height) {
    const expected = `${width}x${height}`;
    const actual = `${metadata.width}x${metadata.height}`;
    if (expected !== actual) {
        console.warn(`warning: preview.html declares ${expected} but preview.png is ${actual}; re-take the screenshot`);
    }
}

const before = fs.statSync(pngPath).size;
const optimized = await sharp(pngPath)
    .png({compressionLevel: 9, palette: true, quality: 92, effort: 10})
    .toBuffer();

if (optimized.length < before) {
    fs.writeFileSync(pngPath, optimized);
}

console.log(`assets/preview.png: ${before} -> ${fs.statSync(pngPath).size} bytes (${metadata.width}x${metadata.height})`);

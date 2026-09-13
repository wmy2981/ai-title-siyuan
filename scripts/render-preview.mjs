// 把 assets/preview.html 的 Chrome 截图压缩到集市上限以内。
//
// preview.png 由 Chrome 按 assets/preview.html 的 body 尺寸截图生成（见 README 的开发说明），
// 直接截出来的图 190KiB 上下，贴着集市 200KiB 的上限。
// 这张图是扁平配色的特性宣传图，调色板量化几乎无损，能把体积压到 1/5。
//
// 尺寸按集市的要求钉死：plugin-sample/README.md 写的建议尺寸是 1024*768，
// 上限 512 KiB。之前只拿 PNG 实际尺寸跟 HTML 声明对，两边一起写错就发现不了——
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const EXPECTED_WIDTH = 1024;
const EXPECTED_HEIGHT = 768;
const MAX_BYTES = 512 * 1024;

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

if (width !== String(EXPECTED_WIDTH) || height !== String(EXPECTED_HEIGHT)) {
    console.error(`assets/preview.html declares ${width}x${height}; the marketplace expects ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`);
    process.exit(1);
}

const actual = `${metadata.width}x${metadata.height}`;
if (actual !== `${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`) {
    console.error(`assets/preview.png is ${actual}, expected ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}; re-take the screenshot`);
    process.exit(1);
}

// 注意这是就地压缩：截图必须先落到 assets/preview.png，跑一次这里，
// 再跑第二次会对已经量化过的图二次量化。要重新压缩，先重截。
const before = fs.statSync(pngPath).size;
const optimized = await sharp(pngPath)
    .png({compressionLevel: 9, palette: true, quality: 92, effort: 10})
    .toBuffer();

if (optimized.length < before) {
    fs.writeFileSync(pngPath, optimized);
}

const after = fs.statSync(pngPath).size;
if (after > MAX_BYTES) {
    console.error(`assets/preview.png is ${after} bytes, over the marketplace limit of ${MAX_BYTES}`);
    process.exit(1);
}

console.log(`assets/preview.png: ${before} -> ${after} bytes (${actual}, limit ${MAX_BYTES})`);

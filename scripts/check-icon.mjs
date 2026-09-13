// 开发辅助：渲染软件内图标（src/icons.ts 里的 24x24 单色路径），
// 按顶栏/面包屑的真实尺寸缩小后放大回来看清像素。
//
// 判据是 24px 以下是否还认得出，盯着 160px 的大图没有意义：
// 顶栏里它只有 16 到 18 像素。
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconsSource = fs.readFileSync(path.join(root, "src", "icons.ts"), "utf8");

const body = /<symbol[^>]*>([\s\S]*?)<\/symbol>/.exec(iconsSource)?.[1];
if (!body) {
    console.error("Could not read the symbol body from src/icons.ts");
    process.exit(1);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="#1f2329">${body}</svg>`;
const master = await sharp(Buffer.from(svg), {density: 384}).resize(96, 96).png().toBuffer();

// 浅底模拟思源顶栏，深底模拟深色主题
const scales = [16, 18, 20, 24];
const magnify = 6;
const gap = 24;
const rowGap = 20;
const swatch = 24 * magnify;

async function strip(background, fill) {
    const layers = [];
    let left = gap;
    for (const size of scales) {
        const rendered = await sharp(Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="${fill}">${body}</svg>`,
        ), {density: 384}).resize(size, size).png().toBuffer();
        layers.push({input: rendered, left, top: rowGap + (swatch - size * magnify) / 2});
        left += size * magnify + gap;
    }
    const width = left;
    return sharp({
        create: {width, height: swatch + rowGap * 2, channels: 4, background},
    }).composite(layers).png().toBuffer();
}

const light = await strip({r: 255, g: 255, b: 255, alpha: 1}, "#1f2329");
const dark = await strip({r: 32, g: 34, b: 38, alpha: 1}, "#d8dbe0");

const target = path.join(root, "dist", "icon-sizes.png");
await sharp({
    create: {
        width: light.length && (await sharp(light).metadata()).width || 600,
        height: ((await sharp(light).metadata()).height ?? 0) + ((await sharp(dark).metadata()).height ?? 0),
        channels: 4,
        background: {r: 255, g: 255, b: 255, alpha: 1},
    },
})
    .composite([{input: light, top: 0, left: 0}, {input: dark, top: (await sharp(light).metadata()).height ?? 0, left: 0}])
    .png()
    .toFile(target);

void master;
console.log(`dist/icon-sizes.png written (${scales.join("/")} px, magnified ${magnify}x, light + dark)`);

/**
 * 软件内使用的图标。
 *
 * 规格对齐思源内置图标：24x24 viewBox、纯 path 轮廓、fill 取 currentColor，
 * 这样顶栏、面包屑、右键菜单里的颜色都会自动跟随所在按钮。
 *
 * 这里不画背景、不加渐变：顶栏里图标只有 16 到 18 像素，
 * 带底色的图形在这个尺寸下会被背景吃掉轮廓。市集那张 160x160 的彩色图标
 * 由 assets/icon.svg 提供，构图与这里一致。
 */

export const ICON_ID = "iconAiTitle";

export const ICON_SVG = `<symbol id="${ICON_ID}" viewBox="0 0 24 24">
<path d="M3.5 6.9a1.6 1.6 0 0 1 1.6-1.6h13.8a1.6 1.6 0 1 1 0 3.2H5.1a1.6 1.6 0 0 1-1.6-1.6Z"/>
<path d="M3.5 13.2a1 1 0 0 1 1-1h6.6a1 1 0 1 1 0 2H4.5a1 1 0 0 1-1-1Z" opacity="0.55"/>
<path d="M3.5 17.7a1 1 0 0 1 1-1h4.2a1 1 0 1 1 0 2H4.5a1 1 0 0 1-1-1Z" opacity="0.35"/>
</symbol>`;

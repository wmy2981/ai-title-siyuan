/**
 * 笔记正文的获取与清洗。
 *
 * 用 /api/export/exportMdContent 而不是 /api/block/getBlockKramdown：
 * 后者会在每个块后面附上 IAL 属性行（{: id="..." updated="..."}），
 * 需要正则剥离且可能误伤正文里合法的花括号内容，而前者直接产出干净 Markdown。
 */
import {fetchSyncPost} from "siyuan";
import {MEDIA_DROP, MEDIA_RAW, type BehaviorSettings, type MediaMode} from "./config";

export interface NoteContent {
    id: string;
    /** 笔记正文，对应提示词里的 <body>：已剥离本地资源引用并截断。 */
    body: string;
    /** 正文是否为空，用于跳过不请求。 */
    empty: boolean;
    /** 仅当抓取本身失败时存在，此时 body 为空、empty 为 true。 */
    message?: string;
}

interface ExportResponse {
    code: number;
    msg: string;
    data?: {
        hPath?: string;
        content?: string;
    };
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "heic"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "flac", "ogg", "oga", "aac", "opus", "wma"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi", "wmv", "flv", "m4v", "mpg", "mpeg"]);

function extensionOf(url: string): string {
    return /\.([a-z0-9]+)$/i.exec(url.split(/[?#]/)[0])?.[1]?.toLowerCase() ?? "";
}

/** 图片语法 `![alt](url)` 的占位符：按扩展名区分图片、音视频与普通附件。 */
function imagePlaceholder(url: string): string {
    const extension = extensionOf(url);
    if (AUDIO_EXTENSIONS.has(extension)) {
        return "[audio]";
    }
    if (VIDEO_EXTENSIONS.has(extension)) {
        return "[video]";
    }
    // 没有扩展名时仍按图片处理：`![]()` 这个语法本身就说明了类型
    return extension === "" || IMAGE_EXTENSIONS.has(extension) ? "[image]" : `[file(.${extension})]`;
}

/** 链接语法 `[text](url)` 的占位符：站内附件带上扩展名，其余一律 `[link]`。 */
function linkPlaceholder(url: string): string {
    const clean = url.split(/[?#]/)[0];
    if (!/^assets\//i.test(clean) && !/^\.{0,2}\//.test(clean)) {
        return "[link]";
    }
    const extension = extensionOf(clean);
    if (extension === "") {
        return "[file]";
    }
    if (IMAGE_EXTENSIONS.has(extension)) {
        return "[image]";
    }
    if (AUDIO_EXTENSIONS.has(extension)) {
        return "[audio]";
    }
    if (VIDEO_EXTENSIONS.has(extension)) {
        return "[video]";
    }
    return `[file(.${extension})]`;
}

/**
 * 按设置处理正文里的链接、图片、嵌入的音视频与 iframe。
 *
 * 这些内容对判断主题几乎没有价值，却会占掉不少字符预算：
 * 一条 assets 路径动辄几十个字符，而模型只需要知道「这里有一张图」。
 * 保留占位符而不是直接丢弃，是为了让模型知道原文在哪儿断开了，
 * 免得它把前后两段不相干的文字当成一句话来读。
 */
function replaceMedia(markdown: string, mode: MediaMode): string {
    if (mode === MEDIA_RAW) {
        return markdown;
    }
    const keep = (label: string): string => (mode === MEDIA_DROP ? "" : label);
    return markdown
        // 音视频与内嵌 iframe 在思源导出里是原样保留的 HTML 标签
        .replace(/<(iframe|video|audio)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/gi, (_match, tag: string) => keep(`[${tag.toLowerCase()}]`))
        .replace(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g, (_match, url: string) => keep(imagePlaceholder(url)))
        .replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_match, _text: string, url: string) => keep(linkPlaceholder(url)));
}

function normalizeWhitespace(markdown: string): string {
    return markdown
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** 按字符数从尾部截断。标题只需要开头的主题信息，所以保留开头。 */
export function truncate(text: string, limit: number): string {
    if (limit <= 0 || text.length <= limit) {
        return text;
    }
    return text.slice(0, limit);
}

/** 去掉 Markdown 结构字符后判断是否真的还有内容。 */
function hasSubstance(text: string): boolean {
    const plain = text
        .replace(/^[#>\-*+\d.\s|]+/gm, "")
        .replace(/[*_`~[\]]/g, "")
        .trim();
    return plain.length > 0;
}

/** 取一篇文档当前的标题，用于确认窗口的对比展示。 */
export async function getDocTitle(id: string): Promise<string> {
    const response = (await fetchSyncPost("/api/block/getDocInfo", {id})) as {
        code: number;
        msg: string;
        data?: {name?: string};
    };
    if (response.code !== 0) {
        throw new Error(response.msg || `Failed to read document info for ${id}`);
    }
    return response.data?.name ?? "";
}

/**
 * 取一篇笔记的正文，供标题生成使用。
 *
 * contentLimit 只作用于正文本身：提示词里的 <id> 与后续的 <toc> 都不受它限制，
 * 目录必须完整才有意义（否则截断后剩下的层级关系反而误导模型）。
 */
export async function fetchNoteContent(id: string, behavior: BehaviorSettings): Promise<NoteContent> {
    const response = (await fetchSyncPost("/api/export/exportMdContent", {
        id,
        // 3 = 仅锚文本，0 = 原始文本，不输出 YAML front matter，不追加文档标题行
        refMode: 3,
        embedMode: 0,
        yfm: false,
        addTitle: false,
        fillCSSVar: false,
        adjustHeadingLevel: false,
    })) as ExportResponse;

    if (response.code !== 0) {
        throw new Error(response.msg || `Failed to export note ${id}`);
    }

    const raw = response.data?.content ?? "";
    const cleaned = truncate(normalizeWhitespace(replaceMedia(raw, behavior.mediaMode)), behavior.contentLimit);
    return {id, body: cleaned, empty: !hasSubstance(cleaned)};
}

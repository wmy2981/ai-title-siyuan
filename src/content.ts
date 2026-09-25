/**
 * 笔记正文的获取与清洗。
 *
 * 用 /api/export/exportMdContent 而不是 /api/block/getBlockKramdown：
 * 后者会在每个块后面附上 IAL 属性行（{: id="..." updated="..."}），
 * 需要正则剥离且可能误伤正文里合法的花括号内容，而前者直接产出干净 Markdown。
 */
import {fetchSyncPost} from "siyuan";
import {
    MEDIA_DROP,
    MEDIA_RAW,
    TRUNCATE_FULL,
    TRUNCATE_HEAD,
    TRUNCATE_TAIL,
    type BehaviorSettings,
    type MediaMode,
    type TruncateMode,
} from "./config";

export interface NoteContent {
    id: string;
    /** 文档当前标题；未启用或取不到时为空串。 */
    title: string;
    /** 笔记正文，对应提示词里的 <body>：已按设置处理媒体引用并截取。 */
    body: string;
    /** 正文是否按长度上限截取过，目录按需传入时据此判断。 */
    truncated: boolean;
    /** 正文是否为空，用于跳过不请求。只看正文，不含文档标题。 */
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

/**
 * 「开头 + 末尾」时插在两段之间的标记。
 *
 * 没有它，模型会把断开的两段当成一句话读：上一段末尾的句子可能正好是
 * 下一段的铺垫，拼起来的意思完全不同。标记本身也占长度额度，先扣掉再分配。
 */
const TRUNCATION_MARKER = "\n\n[...]\n\n";

function clampRatio(ratio: number): number {
    if (!Number.isFinite(ratio)) {
        return 0.5;
    }
    return Math.min(1, Math.max(0, ratio));
}

/**
 * 按设置截取正文。
 *
 * 四种方式都保证结果不超过 limit 个字符（limit <= 0 视为不限制）：
 * both 模式先扣掉标记自身的长度，再按比例把剩余额度分给开头与末尾，
 * 两段相加正好用完额度，不会多出一个字符。
 */
export function truncate(text: string, mode: TruncateMode, limit: number, headRatio: number): string {
    if (mode === TRUNCATE_FULL || limit <= 0 || text.length <= limit) {
        return text;
    }
    if (mode === TRUNCATE_TAIL) {
        return text.slice(text.length - limit);
    }
    if (mode === TRUNCATE_HEAD) {
        // 标题只需要开头的主题信息，所以默认保留开头
        return text.slice(0, limit);
    }
    const budget = limit - TRUNCATION_MARKER.length;
    if (budget <= 0) {
        return text.slice(0, limit);
    }
    const head = Math.round(budget * clampRatio(headRatio));
    const tail = budget - head;
    return `${text.slice(0, head)}${TRUNCATION_MARKER}${tail === 0 ? "" : text.slice(text.length - tail)}`;
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

/** 标题只是补充信息，取不到就当作没有，不让整篇笔记跟着失败。 */
async function readTitle(id: string): Promise<string> {
    try {
        return (await getDocTitle(id)).trim();
    } catch {
        return "";
    }
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
    const cleaned = normalizeWhitespace(replaceMedia(raw, behavior.mediaMode));
    // 空笔记只看正文本身：文档标题不算内容，否则一篇只有标题的空文档
    // 会被当成「有内容」发去请求，模型只能把现有标题换个说法再还回来。
    const empty = !hasSubstance(cleaned);
    const title = behavior.includeTitle ? await readTitle(id) : "";
    // 标题拼在正文最前面，因此同样受长度上限约束，<body> 永远不会超出额度
    const titled = title === "" ? cleaned : `# ${title}\n\n${cleaned}`;
    const body = truncate(titled, behavior.truncateMode, behavior.contentLimit, behavior.truncateHeadRatio);
    return {id, title, body, truncated: body.length < titled.length, empty};
}

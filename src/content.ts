/**
 * 笔记正文的获取与清洗。
 *
 * 用 /api/export/exportMdContent 而不是 /api/block/getBlockKramdown：
 * 后者会在每个块后面附上 IAL 属性行（{: id="..." updated="..."}），
 * 需要正则剥离且可能误伤正文里合法的花括号内容，而前者直接产出干净 Markdown。
 */
import {fetchSyncPost} from "siyuan";

export interface NoteContent {
    id: string;
    /** 用于标题生成的正文，已剥离本地资源引用并截断。 */
    text: string;
    /** 正文是否为空，用于跳过不请求。 */
    empty: boolean;
    /** 仅当抓取本身失败时存在，此时 text 为空、empty 为 true。 */
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

/**
 * 抹掉图片、音频等本地资源引用。
 * `![alt](assets/x.png)` 对判断主题几乎没有价值，却会占掉不少字符预算。
 */
function stripAssetRefs(markdown: string): string {
    return markdown
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)\]\(assets\/[^)]*\)/g, "$1");
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

/** 取一篇笔记的正文，供标题生成使用。 */
export async function fetchNoteContent(id: string, contentLimit: number): Promise<NoteContent> {
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
    const cleaned = truncate(normalizeWhitespace(stripAssetRefs(raw)), contentLimit);
    return {id, text: cleaned, empty: !hasSubstance(cleaned)};
}

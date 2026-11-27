/**
 * 提示词渲染。
 *
 * 占位符在系统提示词与用户提示词里都可用：
 *   {{content}}  拼装好的笔记列表
 *   {{language}} 行为配置里的「标题语言」
 *   {{style}}    行为配置里的「标题风格」
 *   {{guard}}    开启注入防护时的说明，为空表示不追加
 *   {{ocr}}      实际附带图片 OCR 文本时的说明，为空表示不追加
 *   {{system}}   追加到系统提示词末尾的自定义说明
 *   {{user}}     追加到用户提示词末尾的自定义说明
 */
import {
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_USER_PROMPT,
    IMAGE_OCR_HINT,
    INJECTION_GUARD,
    type BehaviorSettings,
} from "../core/config";

export interface NoteText {
    id: string;
    /** 笔记正文。行为配置里的长度上限只作用于它，不含 id 与其他元信息。 */
    body: string;
    /** 笔记目录。未启用目录时为空串，此时不产出 <toc> 元素。 */
    toc: string;
    /** 本篇正文是否实际附带了自动追加的图片 OCR 文本。 */
    hasOcr?: boolean;
}

/**
 * 把多篇笔记拼成 {{content}} 的内容。
 *
 * 用 <note> 标签结构而不是 JSON：模型对标签结构的遵循度更稳定，
 * 且正文里的引号、花括号、代码片段都不需要转义。
 * 标签各自独占一行，正文的 Markdown 结构不会和标签抢行。
 *
 * 目录为空时整个 <toc> 元素都不产出：空标签只会白占 token，
 * 还容易被模型当成「这篇笔记没有小标题」之外的暗示。
 */
export function buildContent(notes: NoteText[]): string {
    return notes
        .map((note) => {
            const toc = note.toc.trim() === "" ? "" : `<toc>\n${note.toc}\n</toc>\n`;
            return `<note>\n<id>${note.id}</id>\n${toc}<body>\n${note.body}\n</body>\n</note>`;
        })
        .join("\n\n");
}

/** 逐个替换占位符。用函数式替换，避免正文里的 $& 等被当成替换模式。 */
function fill(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}

export interface RenderedPrompt {
    system: string;
    user: string;
}

export function renderPrompt(
    notes: NoteText[],
    behavior: BehaviorSettings,
): RenderedPrompt {
    const values = {
        content: buildContent(notes),
        language: behavior.titleLanguage,
        style: behavior.titleStyle,
        // 防护说明与 OCR 说明各自自带结尾空行：哪一项关闭就不占位，
        // 两者都开或只开其一时，段落之间都正好空一行
        guard: behavior.ignoreInjection ? `${INJECTION_GUARD}\n\n` : "",
        ocr: notes.some((note) => note.hasOcr === true) ? `${IMAGE_OCR_HINT}\n\n` : "",
        system: behavior.systemExtra,
        user: behavior.userExtra,
    };
    // 追加位为空时模板末尾会留下空行，去掉后再发出去
    return {
        system: fill(DEFAULT_SYSTEM_PROMPT, values).trim(),
        user: fill(DEFAULT_USER_PROMPT, values).trim(),
    };
}

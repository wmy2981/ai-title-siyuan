/**
 * 提示词渲染。
 *
 * 占位符在系统提示词与用户提示词里都可用：
 *   {{content}}  拼装好的笔记列表
 *   {{language}} 行为配置里的「标题语言」
 *   {{style}}    行为配置里的「标题风格」
 *   {{system}}   追加到系统提示词末尾的自定义说明
 *   {{user}}     追加到用户提示词末尾的自定义说明
 */
import {DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT, type BehaviorSettings} from "./config";

export interface NoteText {
    id: string;
    /** 笔记正文。行为配置里的长度上限只作用于它，不含 id 与其他元信息。 */
    body: string;
    /** 笔记目录。未启用目录时为空串，此时不产出 <toc> 元素。 */
    toc: string;
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
        system: behavior.systemExtra,
        user: behavior.userExtra,
    };
    // 追加位为空时模板末尾会留下空行，去掉后再发出去
    return {
        system: fill(DEFAULT_SYSTEM_PROMPT, values).trim(),
        user: fill(DEFAULT_USER_PROMPT, values).trim(),
    };
}

/**
 * 提示词渲染。
 *
 * 占位符在系统提示词与用户提示词里都可用：
 *   {{content}}  拼装好的笔记列表
 *   {{language}} 行为配置里的「标题语言」
 *   {{style}}    行为配置里的「标题风格」
 */
import type {BehaviorSettings} from "./config";

export interface NoteText {
    id: string;
    /** 笔记正文。行为配置里的长度上限只作用于它，不含 id 与其他元信息。 */
    body: string;
}

/**
 * 把多篇笔记拼成 {{content}} 的内容。
 *
 * 用 <note> 标签结构而不是 JSON：模型对标签结构的遵循度更稳定，
 * 且正文里的引号、花括号、代码片段都不需要转义。
 * 标签各自独占一行，正文的 Markdown 结构不会和标签抢行。
 */
export function buildContent(notes: NoteText[]): string {
    return notes
        .map((note) => `<note>\n<id>${note.id}</id>\n<body>\n${note.body}\n</body>\n</note>`)
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
    };
    return {
        system: fill(behavior.systemPrompt, values),
        user: fill(behavior.userPrompt, values),
    };
}

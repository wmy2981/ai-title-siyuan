import {describe, expect, it} from "vitest";
import {DEFAULT_SETTINGS, type BehaviorSettings} from "../src/config";
import {buildContent, renderPrompt, type NoteText} from "../src/prompt";

function behavior(overrides: Partial<BehaviorSettings> = {}): BehaviorSettings {
    return {...DEFAULT_SETTINGS.behavior, ...overrides};
}

describe("buildContent（#11 {{content}} 传入机制 / #12 目录）", () => {
    it("每篇笔记包在 <note> 里，id 与正文各就各位", () => {
        const content = buildContent([{id: "20260101000000-abc", body: "# Title\n\nbody text", toc: ""}]);
        expect(content).toBe(
            "<note>\n<id>20260101000000-abc</id>\n<body>\n# Title\n\nbody text\n</body>\n</note>",
        );
    });

    it("目录为空时不产出 <toc>，省掉一段只会白占 token 的空标签", () => {
        expect(buildContent([{id: "a", body: "x", toc: "   "}])).not.toContain("<toc>");
    });

    it("目录非空时排在 id 与正文之间", () => {
        const content = buildContent([{id: "a", body: "x", toc: "# H1\n## H2"}]);
        expect(content).toContain("<id>a</id>\n<toc>\n# H1\n## H2\n</toc>\n<body>");
    });

    it("多篇笔记之间空一行", () => {
        const notes: NoteText[] = [{id: "a", body: "1", toc: ""}, {id: "b", body: "2", toc: ""}];
        expect(buildContent(notes)).toBe(`${buildContent([notes[0]])}\n\n${buildContent([notes[1]])}`);
    });
});

describe("renderPrompt（#5 提示词追加位 / #21 当前标题）", () => {
    it("占位符逐个换成配置里的值", () => {
        const {system, user} = renderPrompt([{id: "a", body: "正文", toc: ""}], behavior({
            titleLanguage: "English",
            titleStyle: "short",
            systemExtra: "SYSTEM EXTRA",
            userExtra: "USER EXTRA",
        }));
        expect(system).toContain("SYSTEM EXTRA");
        expect(system).not.toContain("{{system}}");
        expect(user).toContain("Language: English");
        expect(user).toContain("Style: short");
        expect(user).toContain("<id>a</id>");
        expect(user).toContain("USER EXTRA");
        expect(user.endsWith("USER EXTRA")).toBe(true);
    });

    it("追加位为空时不留空行", () => {
        const {system, user} = renderPrompt([{id: "a", body: "正文", toc: ""}], behavior());
        expect(system.trim()).toBe(system);
        expect(user.trim()).toBe(user);
        expect(user).not.toContain("{{user}}");
    });

    it("认不出来的占位符原样留着，方便发现写错了名字", () => {
        const {system} = renderPrompt([{id: "a", body: "x", toc: ""}], behavior({systemExtra: "{{nope}}"}));
        expect(system).toContain("{{nope}}");
    });

    it("正文里的 $& 之类不会被当成替换模式", () => {
        const {user} = renderPrompt([{id: "a", body: "a $& b $1 c", toc: ""}], behavior());
        expect(user).toContain("a $& b $1 c");
    });
});

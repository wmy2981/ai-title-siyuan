import {describe, expect, it} from "vitest";
import {isBlankEditor} from "../src/doc/paste";

/**
 * 只搭一个够 isBlankEditor 用的壳：它读的是 children、每块的 data-type 与 textContent，
 * 再查一次内嵌媒体元素。其余 DOM 能力一概不碰，所以不必为此引入 jsdom。
 */
function editorOf(blocks: {type: string; text?: string; media?: boolean}[]): Element {
    return {
        children: blocks.map((block) => ({
            getAttribute: (name: string) => (name === "data-type" ? block.type : null),
            textContent: block.text ?? "",
            querySelector: () => (block.media ? {} as Element : null),
        })),
    } as unknown as Element;
}

describe("isBlankEditor（#47 只对空白笔记生效）", () => {
    it("空段落、以及只有零宽空格的段落都算空白", () => {
        expect(isBlankEditor(editorOf([]))).toBe(true);
        expect(isBlankEditor(editorOf([{type: "NodeParagraph"}]))).toBe(true);
        // 属性面板里放着零宽空格，它不是正文
        expect(isBlankEditor(editorOf([{type: "NodeParagraph", text: "\u200b"}]))).toBe(true);
        expect(isBlankEditor(editorOf([{type: "NodeHeading", text: "  \n"}]))).toBe(true);
    });

    it("段落里有文字就不是空白", () => {
        expect(isBlankEditor(editorOf([{type: "NodeParagraph", text: "粘贴进来的内容"}]))).toBe(false);
        // 零宽空格夹在文字里同样算文字
        expect(isBlankEditor(editorOf([{type: "NodeParagraph", text: "a\u200b"}]))).toBe(false);
        // 多个块里只要有一块有文字
        expect(isBlankEditor(editorOf([
            {type: "NodeParagraph"},
            {type: "NodeParagraph", text: "x"},
        ]))).toBe(false);
    });

    it("只有图片这类内嵌内容的段落也不是空白", () => {
        expect(isBlankEditor(editorOf([{type: "NodeParagraph", media: true}]))).toBe(false);
        expect(isBlankEditor(editorOf([
            {type: "NodeParagraph"},
            {type: "NodeParagraph", media: true},
        ]))).toBe(false);
    });

    it("段落以外的块一律算有内容：图片、表格、代码块这些没有文字也不是空白", () => {
        for (const type of ["NodeImage", "NodeTable", "NodeCodeBlock", "NodeBlockquote"]) {
            expect(isBlankEditor(editorOf([{type}]))).toBe(false);
        }
    });
});

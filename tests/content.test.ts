import {describe, expect, it} from "vitest";
import {TRUNCATE_BOTH, TRUNCATE_FULL, TRUNCATE_HEAD, TRUNCATE_TAIL, type TruncateMode} from "../src/config";
import {truncate} from "../src/content";

/** truncate 在「开头 + 末尾」两段之间插入的标记，断言长度时要把它的长度算进去。 */
const MARKER = "\n\n[...]\n\n";

const LONG = Array.from({length: 50}, (_, index) => `word${index}`).join(" ");

describe("truncate（#3 笔记内容截取方式）", () => {
    it("正文没超过上限时原样返回", () => {
        expect(truncate("short note", TRUNCATE_HEAD, 100, 0.5)).toBe("short note");
        expect(truncate("short note", TRUNCATE_BOTH, 100, 0.5)).toBe("short note");
    });

    it("上限为 0 或负数视为不限制", () => {
        expect(truncate(LONG, TRUNCATE_HEAD, 0, 0.5)).toBe(LONG);
        expect(truncate(LONG, TRUNCATE_TAIL, -5, 0.5)).toBe(LONG);
    });

    it("总是传入全文时不截取", () => {
        expect(truncate(LONG, TRUNCATE_FULL, 10, 0.5)).toBe(LONG);
    });

    it("保留开头与保留末尾各取对应的一端", () => {
        expect(truncate(LONG, TRUNCATE_HEAD, 20, 0.5)).toBe(LONG.slice(0, 20));
        expect(truncate(LONG, TRUNCATE_TAIL, 20, 0.5)).toBe(LONG.slice(-20));
    });

    it("除「总是传入全文」外，三种方式的结果都不超过上限", () => {
        const modes: TruncateMode[] = [TRUNCATE_HEAD, TRUNCATE_TAIL, TRUNCATE_BOTH];
        for (const mode of modes) {
            for (const limit of [1, 10, MARKER.length, 50, LONG.length - 1]) {
                expect(truncate(LONG, mode, limit, 0.3).length).toBeLessThanOrEqual(limit);
            }
        }
    });

    it("「开头 + 末尾」正好用满额度，标记不额外占字", () => {
        const limit = 100;
        const result = truncate(LONG, TRUNCATE_BOTH, limit, 0.5);
        expect(result.length).toBe(limit);
        expect(result).toContain(MARKER);
        // 两段拼起来之外只剩标记本身
        const [head, tail] = result.split(MARKER);
        expect(head.length + tail.length + MARKER.length).toBe(limit);
    });

    it("按比例把预算分给开头", () => {
        const limit = 204;
        const markerLength = MARKER.length;
        const [head, tail] = truncate(LONG, TRUNCATE_BOTH, limit, 0.25).split(MARKER);
        expect(head.length).toBe(Math.round((limit - markerLength) * 0.25));
        expect(tail.length).toBe(limit - markerLength - head.length);
    });

    it("比例超出 0 到 1 或不是数字时夹回范围内", () => {
        const limit = 60;
        expect(truncate(LONG, TRUNCATE_BOTH, limit, 5).startsWith(LONG.slice(0, limit - MARKER.length))).toBe(true);
        expect(truncate(LONG, TRUNCATE_BOTH, limit, -1).split(MARKER)[0]).toBe("");
        expect(truncate(LONG, TRUNCATE_BOTH, limit, Number.NaN).split(MARKER)[0].length)
            .toBe(Math.round((limit - MARKER.length) * 0.5));
    });

    it("额度装不下标记时退回只保留开头", () => {
        const limit = MARKER.length;
        expect(truncate(LONG, TRUNCATE_BOTH, limit, 0.5)).toBe(LONG.slice(0, limit));
    });
});

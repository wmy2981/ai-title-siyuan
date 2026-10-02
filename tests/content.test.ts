import {beforeEach, describe, expect, it} from "vitest";
import {
    DEFAULT_SETTINGS,
    MEDIA_DROP,
    MEDIA_PLACEHOLDER,
    MEDIA_RAW,
    TOC_NEVER,
    TRUNCATE_BOTH,
    TRUNCATE_FULL,
    TRUNCATE_HEAD,
    TRUNCATE_TAIL,
    type BehaviorSettings,
    type TruncateMode,
} from "../src/config";
import {fetchNoteContent, replaceMedia, truncate} from "../src/content";
import {setFetchSyncPost} from "./stubs/siyuan";

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

/** 按钮块在导出正文里的样子：块信息是「插件包名/块类型」，块内容是一段 JSON。 */
const BUTTON_BLOCK = ';;;button-in-siyuan/button\n{"text":"点我","action":{"type":"link","link":"https://ld246.com"}}\n;;;';

describe("replaceMedia（链接、图片、音视频与自定义块）", () => {
    it("自定义块换成块类型占位符，块内容不再进正文", () => {
        const handled = replaceMedia(`前言\n\n${BUTTON_BLOCK}\n\n正文`, MEDIA_PLACEHOLDER);
        expect(handled.text).toBe("前言\n\n[button]\n\n正文");
        expect(handled.customTokens).toEqual(["[button]"]);
    });

    it("块信息先按 / 切开再解码，取不到块类型时退回整段块信息", () => {
        const name = (info: string): string =>
            replaceMedia(`;;;${info}\n{}\n;;;`, MEDIA_PLACEHOLDER).text;
        expect(name("my%20plugin/%E6%8C%89%E9%92%AE")).toBe("[按钮]");
        expect(name("button-in-siyuan/button")).toBe("[button]");
        expect(name("solo")).toBe("[solo]");
        // 残缺的 % 转义与空的块类型都不能让替换失败
        expect(name("my%plugin/but%ZZton")).toBe("[but%ZZton]");
        expect(name("a/")).toBe("[a/]");
    });

    it("缩进与 CRLF 的围栏一样识别", () => {
        expect(replaceMedia("列表\n  ;;;button-in-siyuan/button\n  {}\n  ;;;\n", MEDIA_PLACEHOLDER).text)
            .toBe("列表\n[button]\n");
        expect(replaceMedia(";;;button-in-siyuan/button\r\n{}\r\n;;;\r\n尾", MEDIA_PLACEHOLDER).text)
            .toBe("[button]\n尾");
    });

    it("块内容里的链接与图片不再单独替换", () => {
        const block = ";;;a/button\n[点我](assets/logo.png)\n![图](assets/logo.png)\n;;;";
        expect(replaceMedia(block, MEDIA_PLACEHOLDER).text).toBe("[button]");
    });

    it("丢弃模式整块去掉，原始传入一字不改", () => {
        const raw = `前言\n${BUTTON_BLOCK}\n正文`;
        expect(replaceMedia(raw, MEDIA_DROP).text).toBe("前言\n\n正文");
        const untouched = replaceMedia(raw, MEDIA_RAW);
        expect(untouched.text).toBe(raw);
        expect(untouched.customTokens).toEqual([]);
    });

    it("没有块信息或没有结束围栏的 ;;; 行不算自定义块", () => {
        const paragraph = "文本\n;;;\n;;;solo\n没有结束围栏";
        expect(replaceMedia(paragraph, MEDIA_PLACEHOLDER).text).toBe(paragraph);
    });
});

describe("fetchNoteContent（自定义块不冒充内容）", () => {
    let exported = "";

    beforeEach(() => {
        setFetchSyncPost((url) => {
            if (url === "/api/export/exportMdContent") {
                return Promise.resolve({code: 0, msg: "", data: {hPath: "/note", content: exported}});
            }
            if (url === "/api/block/getDocInfo") {
                return Promise.resolve({code: 0, msg: "", data: {name: "无标题"}});
            }
            if (url === "/api/outline/getDocOutline") {
                return Promise.resolve({code: 0, msg: "", data: []});
            }
            return Promise.reject(new Error(`unstubbed request: ${url}`));
        });
    });

    const behavior: BehaviorSettings = {
        ...DEFAULT_SETTINGS.behavior,
        mediaMode: MEDIA_PLACEHOLDER,
        contentLimit: 0,
        includeTitle: false,
        tocMode: TOC_NEVER,
    };

    it("正文只有自定义块时按空笔记跳过", async () => {
        exported = BUTTON_BLOCK;
        const note = await fetchNoteContent("20260101000000-abc", behavior);
        expect(note.body).toBe("[button]");
        expect(note.empty).toBe(true);
    });

    it("自定义块配一行字时不算空笔记", async () => {
        exported = `写作安排\n\n${BUTTON_BLOCK}`;
        const note = await fetchNoteContent("20260101000000-abc", behavior);
        expect(note.body).toBe("写作安排\n\n[button]");
        expect(note.empty).toBe(false);
    });
});

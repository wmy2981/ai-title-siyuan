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
} from "../src/core/config";
import {extractImagePaths, fetchNoteContent, replaceMedia, truncate} from "../src/doc/content";
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

describe("fetchNoteContent（#36 传入图片 OCR 结果）", () => {
    let exported = "";
    let docTitle = "示例标题";
    let ocrRequests: string[] = [];
    let ocrHandler: (path: string) => {code: number; msg: string; data?: {text?: string; failed?: boolean}} | Promise<never>;

    const baseBehavior: BehaviorSettings = {
        ...DEFAULT_SETTINGS.behavior,
        mediaMode: MEDIA_PLACEHOLDER,
        contentLimit: 0,
        includeTitle: false,
        tocMode: TOC_NEVER,
    };

    const ocrOn = {...DEFAULT_SETTINGS.extension, includeImageOcr: true};
    const ocrOff = {...DEFAULT_SETTINGS.extension, includeImageOcr: false};

    beforeEach(() => {
        exported = "";
        docTitle = "示例标题";
        ocrRequests = [];
        ocrHandler = () => ({code: 0, msg: "", data: {text: "", failed: false}});
        setFetchSyncPost((url, data) => {
            if (url === "/api/export/exportMdContent") {
                return Promise.resolve({code: 0, msg: "", data: {hPath: "/note", content: exported}});
            }
            if (url === "/api/block/getDocInfo") {
                return Promise.resolve({code: 0, msg: "", data: {name: docTitle}});
            }
            if (url === "/api/outline/getDocOutline") {
                return Promise.resolve({code: 0, msg: "", data: []});
            }
            if (url === "/api/asset/getImageOCRText") {
                const path = (data as {path?: string})?.path ?? "";
                ocrRequests.push(path);
                return Promise.resolve(ocrHandler(path));
            }
            return Promise.reject(new Error(`unstubbed request: ${url}`));
        });
    });

    it("开关关闭或媒体模式为丢弃时完全不请求 OCR", async () => {
        exported = "正文\n\n![图](assets/a.png)";
        ocrHandler = () => ({code: 0, msg: "", data: {text: "不应读取", failed: false}});

        const off = await fetchNoteContent("id-1", baseBehavior, ocrOff);
        expect(ocrRequests).toEqual([]);
        expect(off.body).toBe("正文\n\n[image]");
        expect(off.hasOcr).toBe(false);

        const dropped = await fetchNoteContent("id-1", {...baseBehavior, mediaMode: MEDIA_DROP}, ocrOn);
        expect(ocrRequests).toEqual([]);
        expect(dropped.body).toBe("正文");
        expect(dropped.hasOcr).toBe(false);
    });

    it("占位符与原始模式都在图片同行追加折叠后的 OCR 文本", async () => {
        exported = "前文\n\n![流程图](./assets/flow.png)\n\n后文";
        ocrHandler = () => ({code: 0, msg: "", data: {text: "  第一行\n第二行\t第三列  ", failed: false}});

        const placeholderNote = await fetchNoteContent("id-1", baseBehavior, ocrOn);
        expect(placeholderNote.body).toBe("前文\n\n[image] {OCR text: 第一行 第二行 第三列}\n\n后文");
        expect(placeholderNote.hasOcr).toBe(true);

        const rawNote = await fetchNoteContent("id-1", {...baseBehavior, mediaMode: MEDIA_RAW}, ocrOn);
        expect(rawNote.body).toBe("前文\n\n![流程图](./assets/flow.png) {OCR text: 第一行 第二行 第三列}\n\n后文");
        expect(rawNote.hasOcr).toBe(true);
    });

    it("同一路径多张图片只请求一次并分别追加", async () => {
        exported = "![一](assets/same.png)\n\n中间\n\n![二](assets/same.png)";
        ocrHandler = () => ({code: 0, msg: "", data: {text: "重复截图", failed: false}});

        const note = await fetchNoteContent("id-1", baseBehavior, ocrOn);
        expect(ocrRequests).toEqual(["assets/same.png"]);
        expect(note.body).toBe("[image] {OCR text: 重复截图}\n\n中间\n\n[image] {OCR text: 重复截图}");
        expect(note.hasOcr).toBe(true);
    });

    it("无结果、空结果、failed=true、接口错误与异常都保持原样且不拖垮整篇笔记", async () => {
        exported = [
            "![ok](assets/ok.png)",
            "![empty](assets/empty.png)",
            "![blank](assets/blank.png)",
            "![failed](assets/failed.png)",
            "![err](assets/err.png)",
            "![throw](assets/throw.png)",
        ].join("\n\n");
        ocrHandler = (path) => {
            if (path === "assets/ok.png") {
                return {code: 0, msg: "", data: {text: "有效文本", failed: false}};
            }
            if (path === "assets/empty.png") {
                return {code: 0, msg: "", data: {text: "", failed: false}};
            }
            if (path === "assets/blank.png") {
                return {code: 0, msg: "", data: {text: "   \n\t  ", failed: false}};
            }
            if (path === "assets/failed.png") {
                return {code: 0, msg: "", data: {text: "残缺文本", failed: true}};
            }
            if (path === "assets/err.png") {
                return {code: -1, msg: "error"};
            }
            return Promise.reject(new Error("network down"));
        };

        const note = await fetchNoteContent("id-1", baseBehavior, ocrOn);
        expect(note.body).toBe([
            "[image] {OCR text: 有效文本}",
            "[image]",
            "[image]",
            "[image]",
            "[image]",
            "[image]",
        ].join("\n\n"));
        expect(note.hasOcr).toBe(true);
        expect(note.empty).toBe(false);
    });

    it("带 ?box=、查询参数和 #fragment 的图片路径原样传给内核接口", async () => {
        const pathA = "assets/shot.png?box=20260101000000-box1&width=400#center";
        const pathB = "./assets/other.jpg?box=20260101000000-box2#top";
        exported = `![a](${pathA} "图片标题")\n\n![b](${pathB})`;
        ocrHandler = (path) => ({code: 0, msg: "", data: {text: `OCR:${path}`, failed: false}});

        const note = await fetchNoteContent("id-1", {...baseBehavior, mediaMode: MEDIA_RAW}, ocrOn);
        expect(ocrRequests).toEqual([pathA, pathB]);
        expect(note.body).toContain(`![a](${pathA} "图片标题") {OCR text: OCR:${pathA}}`);
        expect(note.body).toContain(`![b](${pathB}) {OCR text: OCR:${pathB}}`);
    });

    it("自定义块内图片、非图片附件与普通链接不读取也不追加 OCR", async () => {
        const custom = ";;;a/button\n![块内图](assets/inside.png)\n;;;";
        exported = [
            custom,
            "![正文图](assets/outside.png)",
            "![音频](assets/voice.mp3)",
            "![视频](assets/clip.mp4)",
            "![文档](assets/doc.pdf)",
            "[图片链接](assets/linked.png)",
            "![外链图](https://example.com/pic.png)",
        ].join("\n\n");
        ocrHandler = (path) => ({code: 0, msg: "", data: {text: `OCR:${path}`, failed: false}});

        expect(extractImagePaths(exported)).toEqual(["assets/outside.png"]);

        const placeholderNote = await fetchNoteContent("id-1", baseBehavior, ocrOn);
        expect(ocrRequests).toEqual(["assets/outside.png"]);
        expect(placeholderNote.body).toContain("[image] {OCR text: OCR:assets/outside.png}");
        expect(placeholderNote.body).not.toContain("assets/inside.png");

        // 原始模式保留自定义块原文，但块内图片同样不追加 OCR
        ocrRequests = [];
        const rawNote = await fetchNoteContent("id-1", {...baseBehavior, mediaMode: MEDIA_RAW}, ocrOn);
        expect(ocrRequests).toEqual(["assets/outside.png"]);
        expect(rawNote.body).toContain(custom);
        expect(rawNote.body).toContain("![正文图](assets/outside.png) {OCR text: OCR:assets/outside.png}");
        expect(rawNote.body).not.toContain("OCR:assets/inside.png");
    });

    it("纯图片笔记无 OCR 仍跳过，有实质 OCR 时可生成标题", async () => {
        exported = "![截图](assets/only.png)";

        // 无 OCR：仍为空笔记
        const withoutOcr = await fetchNoteContent("id-1", baseBehavior, ocrOn);
        expect(withoutOcr.body).toBe("[image]");
        expect(withoutOcr.empty).toBe(true);
        expect(withoutOcr.hasOcr).toBe(false);

        // 只有标点符号的 OCR：外框 `{OCR text: }` 不能冒充实质内容
        ocrHandler = () => ({code: 0, msg: "", data: {text: "--- ...", failed: false}});
        const punctOnly = await fetchNoteContent("id-1", baseBehavior, ocrOn);
        expect(punctOnly.empty).toBe(true);

        // 有实质 OCR 文本：不再跳过
        ocrHandler = () => ({code: 0, msg: "", data: {text: "思源笔记 OCR 测试", failed: false}});
        const withOcr = await fetchNoteContent("id-1", baseBehavior, ocrOn);
        expect(withOcr.body).toBe("[image] {OCR text: 思源笔记 OCR 测试}");
        expect(withOcr.empty).toBe(false);
        expect(withOcr.hasOcr).toBe(true);
    });

    it("含标题与不含标题、四种截断方式及临界字符数下均不超过 contentLimit", async () => {
        exported = `${"甲".repeat(30)}\n\n![图](assets/long.png)\n\n${"乙".repeat(30)}`;
        ocrHandler = () => ({code: 0, msg: "", data: {text: "丙".repeat(40), failed: false}});
        docTitle = "测试笔记标题";

        for (const includeTitle of [false, true]) {
            for (const truncateMode of [TRUNCATE_HEAD, TRUNCATE_TAIL, TRUNCATE_BOTH] as TruncateMode[]) {
                for (const contentLimit of [10, 25, 45, 80, 120]) {
                    const note = await fetchNoteContent(
                        "id-1",
                        {...baseBehavior, includeTitle, truncateMode, contentLimit, truncateHeadRatio: 0.4},
                        ocrOn,
                    );
                    expect(note.body.length).toBeLessThanOrEqual(contentLimit);
                }
            }
            // full 模式不截断，保留完整 OCR
            const full = await fetchNoteContent(
                "id-1",
                {...baseBehavior, includeTitle, truncateMode: TRUNCATE_FULL, contentLimit: 20},
                ocrOn,
            );
            expect(full.body).toContain(`{OCR text: ${"丙".repeat(40)}}`);
            expect(full.hasOcr).toBe(true);
        }

        // 靠后图片的 OCR 被 head 模式整个截断掉时，hasOcr 应为 false
        const cutOff = await fetchNoteContent(
            "id-1",
            {...baseBehavior, includeTitle: false, truncateMode: TRUNCATE_HEAD, contentLimit: 20},
            ocrOn,
        );
        expect(cutOff.body.length).toBe(20);
        expect(cutOff.hasOcr).toBe(false);
    });
});

import {describe, expect, it} from "vitest";
import {extractTitles, firstBalancedObject, parseJsonObject} from "../src/api/json";

describe("parseJsonObject（#11 模型返回值的容错解析）", () => {
    it("直接的 JSON 对象", () => {
        expect(parseJsonObject('{"a":"标题"}')).toEqual({a: "标题"});
    });

    it("剥掉 markdown 围栏", () => {
        expect(parseJsonObject('```json\n{"a":"标题"}\n```')).toEqual({a: "标题"});
    });

    it("前后有多余说明时取第一段括号配平的子串", () => {
        expect(parseJsonObject('好的，结果如下：\n{"a":"标题"}\n希望有帮助')).toEqual({a: "标题"});
    });

    it("标题里的花括号不会让配平提前结束", () => {
        expect(parseJsonObject('{"a":"函数 {x} 与 \\"引号\\""}')).toEqual({a: '函数 {x} 与 "引号"'});
    });

    it("容忍悬空的尾逗号", () => {
        expect(parseJsonObject('{"a":"标题","b":"另一个",}')).toEqual({a: "标题", b: "另一个"});
    });

    it("数组与纯文本都解析不出来", () => {
        expect(() => parseJsonObject("[1,2]")).toThrow();
        expect(() => parseJsonObject("模型答了一段散文")).toThrow();
    });

    it("括号配平函数在缺少结尾时返回 null", () => {
        expect(firstBalancedObject('{"a":"b"')).toBeNull();
        expect(firstBalancedObject("没有括号")).toBeNull();
    });
});

describe("extractTitles（只认请求过的 id）", () => {
    const ids = ["id-1", "id-2"];

    it("取出请求过的 id 并去掉首尾空白", () => {
        const titles = extractTitles('{"id-1":"  标题一  ","id-2":"标题二"}', ids);
        expect(titles.get("id-1")).toBe("标题一");
        expect(titles.get("id-2")).toBe("标题二");
    });

    it("模型多写的键一律丢弃，绝不把标题写到别的笔记上", () => {
        const titles = extractTitles('{"id-1":"标题一","id-3":"无关"}', ids);
        expect([...titles.keys()]).toEqual(["id-1"]);
        expect(titles.has("id-3")).toBe(false);
    });

    it("漏答的 id 不进结果，由调用方列为失败", () => {
        expect(extractTitles('{"id-2":"标题二"}', ids).has("id-1")).toBe(false);
    });

    it("非字符串与空串都不算标题", () => {
        const titles = extractTitles('{"id-1":42,"id-2":"   "}', ids);
        expect(titles.size).toBe(0);
    });
});

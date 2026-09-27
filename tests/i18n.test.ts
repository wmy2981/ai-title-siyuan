import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

type Table = Record<string, string>;

function loadTable(name: string): Table {
    return JSON.parse(readFileSync(path.join(srcDir, "i18n", `${name}.json`), "utf8")) as Table;
}

const en = loadTable("en");
const zh = loadTable("zh-CN");

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return sourceFiles(full);
        }
        return entry.name.endsWith(".ts") ? [full] : [];
    });
}

/** 源码里出现的 t("key") 调用。前面的 (?<![\w$]) 是为了躲开 format(" 这类同尾字母的方法名。 */
function usedKeys(): Map<string, string> {
    const keys = new Map<string, string>();
    for (const file of sourceFiles(srcDir)) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(/(?<![\w$])t\("([^"]+)"/g)) {
            keys.set(match[1], path.relative(srcDir, file));
        }
    }
    return keys;
}

function placeholders(text: string): string[] {
    return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
}

describe("i18n 文案表", () => {
    it("两份文案的键集合完全一致（含顺序）", () => {
        expect(Object.keys(zh)).toEqual(Object.keys(en));
    });

    it("界面用到的每个键在两份文案里都有", () => {
        const missing = [...usedKeys()]
            .filter(([key]) => en[key] === undefined || zh[key] === undefined)
            .map(([key, file]) => `${key}（${file}）`);
        expect(missing).toEqual([]);
    });

    it("同一个键在两种语言里的占位符一致", () => {
        const mismatched = Object.keys(en)
            .filter((key) => JSON.stringify(placeholders(en[key])) !== JSON.stringify(placeholders(zh[key])))
            .map((key) => `${key}: en ${placeholders(en[key]).join(",")} / zh ${placeholders(zh[key]).join(",")}`);
        expect(mismatched).toEqual([]);
    });

    it("没有空文案", () => {
        const empty = Object.entries({...en, ...zh}).filter(([, value]) => value.trim() === "").map(([key]) => key);
        expect(empty).toEqual([]);
    });
});

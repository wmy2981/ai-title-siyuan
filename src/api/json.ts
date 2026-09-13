/**
 * 从模型输出里保守地抠出「笔记 id → 标题」的映射。
 *
 * 不发送 response_format：它在各家兼容服务上的支持差异极大
 * （Anthropic 兼容层直接忽略、Ollama 不强制、DashScope 只支持 json_object
 * 且不能与思考模式同用），发送反而可能引入 400。所以完全靠客户端容错解析。
 */

/** 剥掉 markdown 代码围栏，模型经常无视「不要围栏」的规定。 */
function stripFences(text: string): string {
    const fenced = /^\s*```(?:json|JSON)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text);
    return fenced ? fenced[1].trim() : text.trim();
}

/**
 * 取出第一段括号配平的子串。
 * 必须跳过字符串字面量里的括号，否则标题里出现 { 或 } 就会提前截断。
 */
export function firstBalancedObject(text: string): string | null {
    const start = text.indexOf("{");
    if (start === -1) {
        return null;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }
        if (char === "{") {
            depth++;
        } else if (char === "}") {
            depth--;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }
    return null;
}

/** 去掉对象或数组里悬空的尾逗号。 */
function stripTrailingCommas(text: string): string {
    return text.replace(/,\s*([}\]])/g, "$1");
}

/**
 * 逐级放宽地解析一个 JSON 对象：
 * 严格解析 → 剥围栏 → 提取配平子串 → 去尾逗号。
 * 全部失败时抛错，由调用方把原始响应展示给用户。
 */
export function parseJsonObject(text: string): Record<string, unknown> {
    const candidates = [text.trim()];
    const stripped = stripFences(text);
    if (stripped !== candidates[0]) {
        candidates.push(stripped);
    }
    const balanced = firstBalancedObject(stripped);
    if (balanced && !candidates.includes(balanced)) {
        candidates.push(balanced);
    }
    const noCommas = stripTrailingCommas(balanced ?? stripped);
    if (!candidates.includes(noCommas)) {
        candidates.push(noCommas);
    }

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // 继续尝试下一个候选形态
        }
    }
    throw new Error(`No JSON object found in: ${text.trim().slice(0, 300)}`);
}

/**
 * 把模型返回的扁平映射收敛成 id → 标题文本。
 *
 * 只认请求过的 id：模型多写的键一律丢弃，避免把标题写到无关笔记上。
 * 缺少的 id 由调用方列为失败，绝不做「按顺序对应」这类猜测。
 */
export function extractTitles(text: string, requestedIds: string[]): Map<string, string> {
    const parsed = parseJsonObject(text);
    const titles = new Map<string, string>();
    for (const id of requestedIds) {
        const value = parsed[id];
        if (typeof value === "string" && value.trim() !== "") {
            titles.set(id, value.trim());
        }
    }
    return titles;
}

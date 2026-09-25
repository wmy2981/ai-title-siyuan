/**
 * 生成流水线：拉正文 → 分批 → 并发请求 → 汇总。
 *
 * 并发上限只限制同时在飞的请求数，超出的批次排队，某个批次一返回就补位。
 * 单个批次失败不影响其他批次，最终统一汇总，避免一篇笔记拖垮整次操作。
 */
import {chat, EMPTY_CONTENT, type ReasoningTrace} from "./api/client";
import {extractTitles} from "./api/json";
import {fetchNoteContent, type NoteContent} from "./content";
import type {ApiSettings, BehaviorSettings} from "./config";
import {debug, debugError} from "./debug";
import {renderPrompt} from "./prompt";

export type NoteFailureReason =
    /** 模型返回的 JSON 里没有这篇笔记的 id。 */
    | "notReturned"
    /** 整批响应无法解析出 JSON 对象，message 里带原始响应。 */
    | "parseFailed"
    /** 响应合法但没有文本，通常是推理耗尽了输出预算。 */
    | "emptyContent"
    /** 正文为空，跳过未请求。 */
    | "skippedEmpty"
    /** 抓取正文失败，message 里带原因。 */
    | "fetchFailed";

export interface NoteResult {
    id: string;
    /** 生成成功时的标题。 */
    title?: string;
    reason?: NoteFailureReason;
    /** 供排查用的错误原文。 */
    message?: string;
}

export interface GenerateOutcome {
    results: NoteResult[];
    /** 失败批次的错误信息，用于汇总提示。 */
    batchErrors: string[];
    /**
     * 设了禁用思考、模型却仍在推理的痕迹。
     * 只在开了开关时才可能非空 —— 没开的时候模型推理是预期行为，不值得提示。
     */
    reasoning?: {batches: number; tokens: number | undefined};
}

export interface GenerateOptions {
    ids: string[];
    api: ApiSettings;
    behavior: BehaviorSettings;
    /** 每完成一个批次回调一次，用于更新进度提示。 */
    onProgress?: (done: number, total: number) => void;
}

function chunk<T>(items: T[], size: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        batches.push(items.slice(i, i + size));
    }
    return batches;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function loadContents(ids: string[], contentLimit: number): Promise<NoteContent[]> {
    const contents: NoteContent[] = [];
    for (const id of ids) {
        try {
            const content = await fetchNoteContent(id, contentLimit);
            debug(`Loaded note ${id}: ${content.body.length} chars${content.empty ? " (empty, will be skipped)" : ""}`);
            contents.push(content);
        } catch (error) {
            debugError(`Failed to load note ${id}`, error);
            contents.push({id, body: "", empty: true, message: messageOf(error)});
        }
    }
    return contents;
}

/**
 * 请求一个批次并返回逐篇结果。
 * 整批解析失败时全部标记为 parseFailed 并带上原始响应，
 * 与「模型漏答某一篇」区分开，便于用户判断是提示词问题还是模型问题。
 */
async function generateBatch(
    batch: NoteContent[],
    api: ApiSettings,
    behavior: BehaviorSettings,
): Promise<{results: NoteResult[]; reasoning?: ReasoningTrace}> {
    const {system, user} = renderPrompt(batch, behavior);
    const result = await chat({system, user}, api, behavior);
    // 解析失败也要把推理痕迹带出去：模型一边推理一边漏答，恰恰是最该提示的情况
    const reasoning = result.reasoning;

    let titles: Map<string, string>;
    try {
        titles = extractTitles(result.text, batch.map((note) => note.id));
    } catch (error) {
        return {
            results: batch.map((note) => ({id: note.id, reason: "parseFailed" as const, message: messageOf(error)})),
            reasoning,
        };
    }

    return {
        results: batch.map((note) => {
            const title = titles.get(note.id);
            return title === undefined ? {id: note.id, reason: "notReturned" as const} : {id: note.id, title};
        }),
        reasoning,
    };
}

/** 汇总一个批次的产出，便于在 console 里核对 id 对应关系。 */
function debugResults(batchIndex: number, results: NoteResult[]): void {
    const generated = results.filter((result) => result.title !== undefined).length;
    debug(`Batch ${batchIndex + 1}: ${generated}/${results.length} title(s) returned`);
    for (const result of results) {
        if (result.title !== undefined) {
            debug(`  ${result.id} -> ${result.title}`);
        } else {
            debug(`  ${result.id} -> FAILED (${result.reason ?? "unknown"})`);
        }
    }
}

/** 并发跑完所有批次，结果按传入顺序排列，便于与选中文档一一对应。 */
export async function generateTitles(options: GenerateOptions): Promise<GenerateOutcome> {
    const {ids, api, behavior, onProgress} = options;
    if (ids.length === 0) {
        return {results: [], batchErrors: []};
    }
    // 没开开关时模型推理是预期行为，不必统计，也就不会提示
    const watchReasoning = api.suppressReasoning;

    const contents = await loadContents(ids, behavior.contentLimit);

    const results: NoteResult[] = [];
    const pending: NoteContent[] = [];
    for (const content of contents) {
        if (content.message !== undefined) {
            results.push({id: content.id, reason: "fetchFailed", message: content.message});
        } else if (content.empty) {
            results.push({id: content.id, reason: "skippedEmpty"});
        } else {
            pending.push(content);
        }
    }

    const batches = chunk(pending, Math.max(1, behavior.batchSize));
    const batchErrors: string[] = [];
    let done = 0;
    debug(
        `Generating titles for ${ids.length} note(s): ${pending.length} with content, ` +
        `${ids.length - pending.length} skipped, ${batches.length} batch(es), concurrency ${Math.min(behavior.concurrency, batches.length)}`,
    );
    onProgress?.(done, batches.length);

    let reasoningBatches = 0;
    let reasoningTokens: number | undefined;

    // 固定并发数的协程池：每个 worker 从共享游标取下一个批次，取完即退出
    let cursor = 0;
    const concurrency = Math.max(1, Math.min(behavior.concurrency, batches.length));
    await Promise.all(
        Array.from({length: concurrency}, async () => {
            while (true) {
                const index = cursor++;
                if (index >= batches.length) {
                    return;
                }
                const batch = batches[index];
                try {
                    const outcome = await generateBatch(batch, api, behavior);
                    debugResults(index, outcome.results);
                    results.push(...outcome.results);
                    if (watchReasoning && outcome.reasoning) {
                        reasoningBatches++;
                        if (outcome.reasoning.tokens !== undefined) {
                            reasoningTokens = (reasoningTokens ?? 0) + outcome.reasoning.tokens;
                        }
                    }
                } catch (error) {
                    const message = messageOf(error);
                    debugError(`Batch ${index + 1}/${batches.length} failed`, error);
                    batchErrors.push(message);
                    const reason: NoteFailureReason = message === EMPTY_CONTENT ? "emptyContent" : "notReturned";
                    results.push(...batch.map((note) => ({id: note.id, reason, message})));
                }
                done++;
                onProgress?.(done, batches.length);
            }
        }),
    );

    const byId = new Map(results.map((result) => [result.id, result]));
    return {
        results: ids.map((id) => byId.get(id) ?? {id, reason: "notReturned"}),
        batchErrors,
        reasoning: reasoningBatches > 0 ? {batches: reasoningBatches, tokens: reasoningTokens} : undefined,
    };
}

/** 单篇重新生成：与批量走同一套逻辑，保证行为一致。 */
export async function regenerateTitle(
    id: string,
    api: ApiSettings,
    behavior: BehaviorSettings,
): Promise<NoteResult> {
    const outcome = await generateTitles({ids: [id], api, behavior});
    return outcome.results[0] ?? {id, reason: "notReturned"};
}

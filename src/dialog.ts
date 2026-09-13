/**
 * 生成结果的确认窗口。
 *
 * 每条都可单独勾选与编辑，并支持单条重新生成；
 * 窗口里明写「无法撤销」，因为思源的文档重命名没有撤销栈。
 */
import {Dialog, showMessage} from "siyuan";
import {applyTitles} from "./apply";
import type {ApiSettings, BehaviorSettings} from "./config";
import type {T} from "./i18n";
import {regenerateTitle, type NoteResult} from "./pipeline";

export interface NoteInfo {
    id: string;
    /** 文档当前的标题，用于展示对比。 */
    title: string;
}

interface Row {
    id: string;
    result: NoteResult;
    checkbox: HTMLInputElement;
    input: HTMLInputElement;
    status: HTMLElement;
    element: HTMLElement;
}

export interface GenerateDialogOptions {
    t: T;
    results: NoteResult[];
    batchErrors: string[];
    /** 笔记 id → 当前标题，用于展示「原标题 → AI 标题」。 */
    notes: Map<string, NoteInfo>;
    api: ApiSettings;
    behavior: BehaviorSettings;
}

function div(className?: string, text?: string): HTMLDivElement {
    const node = document.createElement("div");
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

function button(className: string, text: string): HTMLButtonElement {
    const node = document.createElement("button");
    node.className = className;
    node.textContent = text;
    return node;
}

/** 思源的开关控件需要 label 包裹，input 本身放在 label 内。 */
function switchControl(): HTMLInputElement {
    const label = document.createElement("label");
    label.className = "fn__flex-center b3-switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    label.append(input);
    return input;
}

/** 把失败原因翻译成一句人话。 */
function reasonText(t: T, result: NoteResult): string {
    switch (result.reason) {
        case "notReturned":
            return t("errorNotFound");
        case "parseFailed":
        case "fetchFailed":
            return result.message ?? t("errorNotFound");
        case "emptyContent":
            return t("errorEmptyContent");
        default:
            return "";
    }
}

/** 写入成功后的统一提示。 */
function reportApplied(t: T, count: number): void {
    if (count > 0) {
        showMessage(t("summarySuccess", {count}), 4000, "info", "ai-title-summary");
    }
}

function reportApplyFailures(
    t: T,
    failed: {edit: {id: string; title: string}; message: string}[],
    titleOf: (id: string) => string,
): void {
    for (const failure of failed) {
        showMessage(t("applyFailed", {
            title: titleOf(failure.edit.id),
            message: failure.message,
        }), 10000, "error");
    }
}

export function openGenerateDialog(options: GenerateDialogOptions): void {
    const {t, batchErrors, api, behavior} = options;
    const notes = options.notes;

    const dialog = new Dialog({
        title: t("dialogTitle"),
        width: "720px",
        height: "70vh",
        content: '<div class="b3-dialog__content"><div class="ai-title__dialog"></div></div>',
    });

    const body = dialog.element.querySelector<HTMLElement>(".ai-title__dialog");
    const contentRoot = body?.parentElement;
    if (!body || !contentRoot) {
        return;
    }

    const titleOf = (id: string): string => notes.get(id)?.title || id;

    body.append(div("ai-title__hint", t("dialogHint")));
    if (batchErrors.length > 0) {
        body.append(div(
            "ai-title__hint",
            `${t("summaryBatchFailed", {count: batchErrors.length})} — ${batchErrors.join("；")}`,
        ));
    }

    const rows: Row[] = [];

    for (const result of options.results) {
        // 空内容根本没发过请求，放进确认列表只会造成困扰
        if (result.reason === "skippedEmpty") {
            continue;
        }
        const info = notes.get(result.id) ?? {id: result.id, title: result.id};
        const generated = result.title !== undefined;

        const rowElement = div("ai-title__row");
        const head = div("ai-title__row-head");
        const checkbox = switchControl();
        checkbox.checked = generated;

        const name = div("ai-title__row-name", info.title);
        const original = div("ai-title__original", generated ? info.title : "");
        original.title = info.title;
        const status = div("ai-title__row-status", generated ? "" : reasonText(t, result));

        const actions = div("fn__flex");
        const regenButton = button("b3-button b3-button--text", t("regenerate"));
        actions.append(regenButton);

        const input = document.createElement("input");
        input.className = "b3-text-field fn__block ai-title__title-input";
        input.value = result.title ?? "";
        input.placeholder = info.title;
        input.disabled = !generated;

        const row: Row = {id: result.id, result, checkbox, input, status, element: rowElement};

        regenButton.addEventListener("click", async () => {
            regenButton.disabled = true;
            regenButton.textContent = t("regenerating");
            try {
                const next = await regenerateTitle(result.id, api, behavior);
                result.title = next.title;
                result.reason = next.reason;
                result.message = next.message;
                const ok = next.title !== undefined;
                input.value = next.title ?? "";
                input.disabled = !ok;
                checkbox.checked = ok;
                rowElement.classList.toggle("ai-title__row--failed", !ok);
                status.textContent = ok ? "" : reasonText(t, next);
                original.textContent = ok ? info.title : "";
                updateCounter();
            } catch (error) {
                status.textContent = error instanceof Error ? error.message : String(error);
            } finally {
                regenButton.disabled = false;
                regenButton.textContent = t("regenerate");
            }
        });

        checkbox.addEventListener("change", () => {
            input.disabled = !checkbox.checked || result.title === undefined;
            updateCounter();
        });

        if (!generated) {
            rowElement.classList.add("ai-title__row--failed");
        }

        head.append(checkbox.parentElement ?? checkbox, name, original, actions);
        rowElement.append(head, input, status);
        body.append(rowElement);
        rows.push(row);
    }

    const footer = div("b3-dialog__action");
    const selectAll = button("b3-button b3-button--text", t("selectAll"));
    const selectNone = button("b3-button b3-button--text", t("selectNone"));
    const spacer = div("ai-title__footer-spacer");
    const cancel = button("b3-button b3-button--cancel", t("cancel"));
    const apply = button("b3-button b3-button--text", t("apply"));

    const selectable = (): Row[] => rows.filter((row) => row.result.title !== undefined);
    const selected = (): Row[] => selectable().filter((row) => row.checkbox.checked);

    function updateCounter(): void {
        const count = selected().length;
        apply.textContent = count > 0 ? t("applyCount", {count}) : t("apply");
        apply.disabled = count === 0;
    }

    selectAll.addEventListener("click", () => {
        for (const row of selectable()) {
            row.checkbox.checked = true;
            row.input.disabled = false;
        }
        updateCounter();
    });
    selectNone.addEventListener("click", () => {
        for (const row of rows) {
            row.checkbox.checked = false;
            row.input.disabled = true;
        }
        updateCounter();
    });
    cancel.addEventListener("click", () => dialog.destroy());

    apply.addEventListener("click", async () => {
        const edits = selected()
            .map((row) => ({id: row.id, title: row.input.value.trim()}))
            .filter((edit) => edit.title !== "");
        if (edits.length === 0) {
            return;
        }
        apply.disabled = true;
        const outcome = await applyTitles(edits);
        dialog.destroy();
        reportApplyFailures(t, outcome.failed, titleOf);
        reportApplied(t, outcome.applied.length);
    });

    footer.append(selectAll, selectNone, spacer, cancel, apply);
    contentRoot.append(footer);
    updateCounter();
}

/** 自动应用档位下直接写入，仍会汇总失败项。 */
export async function applyGeneratedSilently(
    t: T,
    results: NoteResult[],
    notes: Map<string, NoteInfo>,
): Promise<void> {
    const edits = results
        .filter((result): result is NoteResult & {title: string} => result.title !== undefined)
        .map((result) => ({id: result.id, title: result.title}));

    const outcome = await applyTitles(edits);
    reportApplyFailures(t, outcome.failed, (id) => notes.get(id)?.title ?? id);
    reportApplied(t, outcome.applied.length);
}

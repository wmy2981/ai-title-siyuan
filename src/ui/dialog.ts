/**
 * 生成结果的确认窗口。
 *
 * 每条都可单独勾选与编辑，并支持单条重新生成；
 * 窗口里明写「无法撤销」，因为思源的文档重命名没有撤销栈。
 */
import {Dialog, showMessage} from "siyuan";
import {applyTitles} from "../doc/apply";
import type {ApiSettings, BehaviorSettings} from "../core/config";
import {debug} from "../core/debug";
import type {T} from "../core/i18n";
import {regenerateTitle, type NoteResult} from "../title/pipeline";

/** 重新生成的回执共用同一个 id：连点几行时后一条顶掉前一条，而不是堆满屏幕。 */
const REGENERATE_ID = "ai-title-regenerate";

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

/**
 * 思源官方的纯图标按钮，写法见 app/src/ai/editor.ts 的 createTaskIconButton。
 * 三处都不能省：block__icon 默认 opacity:0，要 --show 才可见；
 * ariaLabel 是思源全局的悬浮提示机制，靠 aria-label 取文案、data-position 定方向。
 */
function iconButton(icon: string, label: string): HTMLButtonElement {
    const node = document.createElement("button");
    node.className = "block__icon block__icon--show ariaLabel";
    node.dataset.position = "north";
    node.setAttribute("aria-label", label);
    node.innerHTML = `<svg><use xlink:href="#${icon}"></use></svg>`;
    return node;
}

/** 官方开关：b3-switch 必须落在 input 上，包一层 label 会同时画出原生复选框和畸形胶囊。 */
function switchControl(): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "b3-switch fn__flex-center";
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

/**
 * 给对话框外壳挂上私有类名，样式里据此常驻 `will-change: transform`（见 index.scss）。
 *
 * 宿主的 `.b3-dialog__container` 用 `transform: scale(.8)` + `opacity: 0` 淡入，`.b3-dialog__scrim`
 * 同时淡入遮罩：过渡的起点与终点浏览器都要新建、销毁合成层，而 App 的 WebView 在拆层那一帧
 * 只能提交旧的页面纹理，面板打开时就插一帧旧画面（移动端上尤其明显，面板几乎铺满屏幕）。
 * 这里在加入场类之前就挂上私有类，让图层在过渡开始前已经存在，入场只改它的属性。
 *
 * 只加图层提示，不覆盖宿主的 `transition`，也不改 `b3-dialog--open` 的切换时序。
 *
 * 宿主 `Dialog` 本身有 `containerClassName` 选项，但 `siyuan` 包里还没有这个字段的类型声明
 * （见 minAppVersion 对应的 app/src/dialog/index.ts），所以按构造完立即补类的写法处理，
 * 不给全项目扩散类型断言。
 */
export function preheatPanel(dialog: Dialog): void {
    dialog.element.querySelector<HTMLElement>(".b3-dialog__container")?.classList.add("ai-title__panel");
}

/**
 * 关窗时不把焦点还给打开前的元素（#46）。
 *
 * 宿主 `Dialog` 构造时把当前焦点元素记成 `previousFocus`，`destroy()` 之后再 `focus()` 回去
 * （app/src/dialog/index.ts）。移动端 App 又把 `HTMLElement.prototype.focus` 改写成经原生桥接
 * 唤起软键盘（app/src/mobile/index.ts）：在设置面板之上再关一层弹窗时，这一下没人要的键盘
 * 会改掉 WebView 高度并整页重排，真机上表现为卡一下、偶发重载前端。
 *
 * 该字段在 `siyuan` 包里没有类型声明，只为这一处做窄类型扩展，不扩散成全局断言。
 * 宿主改名时这里静默失效，代价只是焦点回到 body，不会连带其它行为。
 */
export function skipFocusRestore(dialog: Dialog): void {
    (dialog as Dialog & {previousFocus?: HTMLElement}).previousFocus = undefined;
}

export function openGenerateDialog(options: GenerateDialogOptions): void {
    const {t, batchErrors, api, behavior} = options;
    const notes = options.notes;

    const dialog = new Dialog({
        title: t("dialogTitle"),
        width: "720px",
        // 不固定高度：条目少时窗口就小，多时由 .ai-title__dialog 的 max-height 兜住。
        // 页脚必须挂在 .b3-dialog__body 下：挂进 .b3-dialog__content 会跟着内容滚，
        // 结果就是条目少时按钮浮在半空、下面留一大片空白。
        content: '<div class="b3-dialog__content"><div class="ai-title__dialog"></div></div>' +
            '<div class="b3-dialog__action"></div>',
    });
    // 正文全在下面同步拼完，入场期间不再插入、替换任何内容
    preheatPanel(dialog);

    const body = dialog.element.querySelector<HTMLElement>(".ai-title__dialog");
    const action = dialog.element.querySelector<HTMLElement>(".b3-dialog__action");
    if (!body || !action) {
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

        // 这里显示的就是文档当前标题，与下面输入框里的 AI 标题构成对照，无需再重复一次
        const name = div("ai-title__row-name", info.title);
        const status = div("ai-title__row-status", generated ? "" : reasonText(t, result));

        const actions = div("fn__flex");
        // 图标取自思源内置图标集，与它自己 AI 面板里的「重试」是同一个
        const regenButton = iconButton("iconRefresh", t("regenerate"));
        // 没有文字，忙碌状态靠图标旋转 + 改写悬浮提示表达
        const setBusy = (busy: boolean): void => {
            regenButton.disabled = busy;
            regenButton.classList.toggle("fn__rotate", busy);
            regenButton.setAttribute("aria-label", t(busy ? "regenerating" : "regenerate"));
        };
        actions.append(regenButton);

        const input = document.createElement("input");
        input.className = "b3-text-field fn__block ai-title__title-input";
        // 不放 placeholder：上一行已经写着当前标题，再显示一次是重复，
        // 而失败行（输入框为空且禁用）正好会把这份重复露出来
        input.value = result.title ?? "";
        input.disabled = !generated;

        const row: Row = {id: result.id, result, checkbox, input, status, element: rowElement};

        regenButton.addEventListener("click", async () => {
            debug(`Regenerating title for ${result.id}`);
            setBusy(true);
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
                updateCounter();
                // 模型给出同一个标题时，界面上一丝变化都没有，看着像按钮没反应。
                // 这里报一次，让「点过了、也回来了」有回执。
                if (next.title !== undefined) {
                    showMessage(t("regenerated", {title: next.title}), 4000, "info", REGENERATE_ID);
                }
            } catch (error) {
                status.textContent = error instanceof Error ? error.message : String(error);
            } finally {
                setBusy(false);
            }
        });

        checkbox.addEventListener("change", () => {
            input.disabled = !checkbox.checked || result.title === undefined;
            updateCounter();
        });

        if (!generated) {
            rowElement.classList.add("ai-title__row--failed");
        }

        head.append(checkbox, name, actions);
        rowElement.append(head, input, status);
        body.append(rowElement);
        rows.push(row);
    }

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
        debug(`Applying ${edits.length} edited title(s): ${edits.map((edit) => edit.id).join(", ")}`);
        const outcome = await applyTitles(edits);
        debug(`Apply finished: ${outcome.applied.length} applied, ${outcome.failed.length} failed`);
        dialog.destroy();
        reportApplyFailures(t, outcome.failed, titleOf);
        reportApplied(t, outcome.applied.length);
    });

    action.append(selectAll, selectNone, spacer, cancel, apply);
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
    debug(`Silent apply finished: ${outcome.applied.length} applied, ${outcome.failed.length} failed`);
    reportApplyFailures(t, outcome.failed, (id) => notes.get(id)?.title ?? id);
    reportApplied(t, outcome.applied.length);
}

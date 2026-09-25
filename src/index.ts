/**
 * AI 标题生成插件入口。
 *
 * 四个入口最终都汇聚到 runGeneration：
 * 顶栏按钮、编辑器面包屑按钮、文档树右键菜单、命令面板。
 */
import {getActiveEditor, Plugin, showMessage, hideMessage} from "siyuan";
import type {ICommandContext, IMenu, IProtyle, TEventBus} from "siyuan";
import {applyGeneratedSilently, openGenerateDialog, type NoteInfo} from "./dialog";
import {
    DEFAULT_SETTINGS,
    defaultTitleLanguage,
    hasProviderConfig,
    mergeSettings,
    STORAGE_NAME,
    type PluginSettings,
} from "./config";
import {getDocTitle} from "./content";
import {debug, setDebug} from "./debug";
import {makeT, type T} from "./i18n";
import {generateTitles, type GenerateOutcome, type NoteResult} from "./pipeline";
import {openSettingsPanel} from "./settings-panel";
import {ICON_ID, ICON_SVG} from "./icons";
import "./index.scss";

const TOP_BAR_ID = "ai-title-topbar";
const BREADCRUMB_ID = "ai-title-breadcrumb";
const PROGRESS_ID = "ai-title-progress";

/** 文档树右键菜单事件的 detail，SDK 未导出该事件的具名类型。 */
interface DocTreeMenuDetail {
    menu: {addItem: (item: IMenu) => HTMLElement};
    elements: NodeListOf<HTMLElement>;
    type: string;
}

export default class AiTitlePlugin extends Plugin {
    private settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
    private t: T = makeT({});
    private topBarElement?: HTMLElement;
    private breadcrumbRegistered = false;

    async onload(): Promise<void> {
        this.t = makeT(this.i18n);
        await this.loadSettings();
        this.addIcons(ICON_SVG);
        this.registerCommand();
        this.registerDocTreeMenu();
    }

    async onLayoutReady(): Promise<void> {
        this.syncUiEntries();
    }

    /** 配置被同步或覆盖后重新读取，避免内存里的旧值被写回。 */
    async onDataChanged(): Promise<void> {
        await this.loadSettings();
        this.syncUiEntries();
    }

    async onunload(): Promise<void> {
        this.removeTopBarEntry();
        this.removeBreadcrumbEntry();
    }

    openSetting(): void {
        openSettingsPanel({
            t: this.t,
            settings: this.settings,
            onSave: async (next) => {
                this.settings = next;
                setDebug(next.ui.debug);
                await this.saveData(STORAGE_NAME, next);
                this.syncUiEntries();
            },
        });
    }

    private async loadSettings(): Promise<void> {
        const stored = await this.loadData(STORAGE_NAME);
        this.settings = mergeSettings(stored);
        setDebug(this.settings.ui.debug);

        // 首次运行时标题语言跟随思源界面语言，之后以用户设置为准。
        // 这里刻意不回写：loadData 读失败时返回空值，与真正的首次运行无法区分，
        // 一旦把它当成首次运行写回默认值，用户已存的配置就被覆盖掉了。
        // 代价只是在用户第一次保存之前，每次加载都要重新推导一次，结果相同。
        if (!stored) {
            this.settings.behavior.titleLanguage = defaultTitleLanguage(
                (window as unknown as {siyuan?: {config?: {lang?: string}}}).siyuan?.config?.lang ?? "en",
            );
        }
        debug(`Settings loaded (debug mode on)`);
    }

    /** 三个界面开关的当前状态同步到实际注册的入口上。 */
    private syncUiEntries(): void {
        if (this.settings.ui.showTopBar) {
            this.addTopBarEntry();
        } else {
            this.removeTopBarEntry();
        }
        if (this.settings.ui.showBreadcrumb) {
            this.addBreadcrumbEntry();
        } else {
            this.removeBreadcrumbEntry();
        }
    }

    private addTopBarEntry(): void {
        if (this.topBarElement?.isConnected) {
            return;
        }
        this.topBarElement = this.addTopBar({
            id: TOP_BAR_ID,
            icon: ICON_ID,
            title: this.t("actionTopBar"),
            position: "right",
            callback: () => {
                const id = getActiveEditor()?.protyle?.block?.rootID;
                if (!id) {
                    showMessage(this.t("noActiveNote"), 6000, "error");
                    return;
                }
                void this.runGeneration([id]);
            },
        });
    }

    /** 基类已有同名的 removeTopBar/removeBreadcrumb，所以这里用 Entry 后缀区分。 */
    private removeTopBarEntry(): void {
        try {
            this.removeTopBar(TOP_BAR_ID);
        } catch {
            // 未注册时移除会抛错，忽略即可
        }
        this.topBarElement = undefined;
    }

    private addBreadcrumbEntry(): void {
        if (this.breadcrumbRegistered) {
            return;
        }
        this.addBreadcrumbButton({
            id: BREADCRUMB_ID,
            icon: ICON_ID,
            title: this.t("actionBreadcrumb"),
            callback: (_event, protyle: IProtyle) => {
                const id = protyle?.block?.rootID;
                if (!id) {
                    showMessage(this.t("noActiveNote"), 6000, "error");
                    return;
                }
                void this.runGeneration([id]);
            },
        });
        this.breadcrumbRegistered = true;
    }

    private removeBreadcrumbEntry(): void {
        if (!this.breadcrumbRegistered) {
            return;
        }
        try {
            this.removeBreadcrumbButton(BREADCRUMB_ID);
        } catch {
            // 未注册时移除会抛错，忽略即可
        }
        this.breadcrumbRegistered = false;
    }

    private registerCommand(): void {
        this.addCommand({
            langKey: "commandGenerate",
            langText: this.t("commandGenerate"),
            execute: (context: ICommandContext) => {
                const id = context.protyle?.block?.rootID ?? getActiveEditor()?.protyle?.block?.rootID;
                if (!id) {
                    showMessage(this.t("noActiveNote"), 6000, "error");
                    return;
                }
                void this.runGeneration([id]);
            },
        });
    }

    /**
     * 文档树右键菜单。只处理单篇与多篇文档选中：
     * 笔记本和混合选中不显示入口，因为插件处理的是笔记而不是笔记本。
     * 菜单项会被思源自动收进「插件」子菜单。
     */
    private registerDocTreeMenu(): void {
        const handler = (event: CustomEvent<DocTreeMenuDetail>): void => {
            // 开关在注册之后才可能被改动，所以在这里读实时配置
            if (!this.settings.ui.showDocTreeMenu) {
                return;
            }
            const {menu, elements, type} = event.detail;
            if (type !== "doc" && type !== "docs") {
                return;
            }
            const ids = Array.from(elements)
                .filter((element) => element.getAttribute("data-type") === "navigation-file")
                .map((element) => element.getAttribute("data-node-id"))
                .filter((id): id is string => !!id);
            if (ids.length === 0) {
                return;
            }
            menu.addItem({
                icon: ICON_ID,
                label: ids.length === 1 ? this.t("actionSingle") : this.t("actionMultiple", {count: ids.length}),
                click: () => void this.runGeneration(ids),
            });
        };

        this.eventBus.on("open-menu-doctree" as TEventBus, handler as (event: CustomEvent<unknown>) => void);
    }

    /** 四个入口共用的执行路径：取正文 → 并发请求 → 弹窗或直接应用。 */
    private async runGeneration(ids: string[]): Promise<void> {
        const {api, behavior} = this.settings;
        if (!hasProviderConfig(api)) {
            showMessage(this.t("noProvider"), 6000, "error");
            return;
        }
        debug(`Generation started for ${ids.length} note(s): ${ids.join(", ")}`);

        try {
            const outcome = await generateTitles({
                ids,
                api,
                behavior,
                onProgress: (done, total) => {
                    // 只有确实分批时才值得显示进度
                    if (total > 1) {
                        showMessage(this.t("progressMessage", {done, total}), -1, "info", PROGRESS_ID);
                    }
                },
            });
            hideMessage(PROGRESS_ID);
            this.reportIneffectiveReasoning(outcome.reasoning);
            await this.handleOutcome(ids, outcome.results, outcome.batchErrors);
        } catch (error) {
            hideMessage(PROGRESS_ID);
            const message = error instanceof Error ? error.message : String(error);
            debug(`Generation aborted: ${message}`);
            showMessage(message, 12000, "error");
        }
    }

    private async handleOutcome(ids: string[], results: NoteResult[], batchErrors: string[]): Promise<void> {
        const notes = await this.collectNoteInfo(ids);
        const generated = results.filter((result) => result.title !== undefined);
        debug(`Generation finished: ${generated.length}/${ids.length} title(s) produced`);
        if (batchErrors.length > 0) {
            debug(`${batchErrors.length} batch(es) failed`, batchErrors);
        }

        if (generated.length === 0) {
            this.reportFailures(results, notes);
            return;
        }

        // 「总是」是字面意思：单篇还是多篇都直接写回，不再拦一道确认。
        // 「仅单篇笔记」则只在确实是一篇时静默，多篇仍然先给确认窗口。
        // 批次出错时同样会弹窗（见下面的 batchErrors 条件）——
        // 那种情况下有一部分笔记没有拿到标题，值得让人先看一眼再决定。
        const mayApplySilently = this.settings.behavior.autoApply === "always" ||
            (this.settings.behavior.autoApply === "single" && ids.length === 1);

        if (mayApplySilently && batchErrors.length === 0) {
            await applyGeneratedSilently(this.t, results, notes);
            this.reportFailures(results, notes);
            return;
        }

        openGenerateDialog({
            t: this.t,
            results,
            batchErrors,
            notes,
            api: this.settings.api,
            behavior: this.settings.behavior,
        });
    }

    /**
     * 开了「禁用思考」、模型却仍在推理时提示一次。
     *
     * 这类失败不会以报错的形式出现 —— 供应商不认那个字段时通常静默忽略，
     * 请求照样成功，只是每次都在为一个用不上的思维链多付 token 和等待。
     * 所以这里必须主动说，否则用户没有任何办法发现开关是空的。
     */
    private reportIneffectiveReasoning(reasoning: GenerateOutcome["reasoning"]): void {
        if (!reasoning) {
            return;
        }
        debug(`Disable thinking had no effect in ${reasoning.batches} batch(es), ${reasoning.tokens ?? "?"} reasoning token(s)`);
        showMessage(
            reasoning.tokens === undefined
                ? this.t("reasoningStillOnNoCount")
                : this.t("reasoningStillOn", {tokens: reasoning.tokens}),
            12000,
            "error",
        );
    }

    /** 取每篇笔记当前的标题，用于确认窗口里的对比展示与提示文案。 */
    private async collectNoteInfo(ids: string[]): Promise<Map<string, NoteInfo>> {
        const notes = new Map<string, NoteInfo>();
        for (const id of ids) {
            let title = id;
            try {
                title = (await getDocTitle(id)) || id;
            } catch {
                // 取不到标题就退回用 id，不影响流程
            }
            notes.set(id, {id, title});
        }
        return notes;
    }

    /** 未生成成功的笔记统一提示，避免逐条弹提示刷屏。 */
    private reportFailures(results: NoteResult[], notes: Map<string, NoteInfo>): void {
        const failed = results.filter((result) => result.title === undefined);
        if (failed.length === 0) {
            return;
        }
        const label = (id: string): string => notes.get(id)?.title ?? id;
        const missing = failed.filter((result) =>
            result.reason === "notReturned" || result.reason === "parseFailed");
        const skipped = failed.filter((result) => result.reason === "skippedEmpty");
        const errored = failed.filter((result) =>
            result.reason === "emptyContent" || result.reason === "fetchFailed");

        if (missing.length > 0) {
            showMessage(this.t("summaryNotReturned", {
                count: missing.length,
                list: missing.map((result) => label(result.id)).join("、"),
            }), 10000, "error");
        }
        if (skipped.length > 0) {
            // 空笔记没发过请求，必须说清楚「跳过」不是「失败」，
            // 否则用户会去翻供应商配置找一个根本不存在的故障
            showMessage(this.t("summarySkipped", {
                count: skipped.length,
                list: skipped.map((result) => label(result.id)).join("、"),
            }), 3000);
        }
        for (const result of errored) {
            const message = result.reason === "emptyContent"
                ? this.t("errorEmptyContent")
                : result.message ?? this.t("errorNotFound");
            showMessage(`${label(result.id)}：${message}`, 10000, "error");
        }
    }
}

/**
 * 设置面板。
 *
 * 用官方的 `Setting` + `addItem`，不再自建对话框：面板的对话框、保存/取消按钮和移动端形态
 * 都交给宿主决定。宿主从 v3.8.10-alpha.7 起把 `Setting` 建在 `MobileDialog` 上，移动端会自动
 * 以底部抽屉打开（siyuan-note/siyuan#21160），插件这边不自行实现抽屉。
 *
 * 控件只绑事件、不写初值：初值统一由各组返回的 sync 写入，
 * 与「导入后重刷」共用同一条路径。漏掉开头那次 sync 会让面板一律显示空白——
 * 存进去的配置看上去就像根本没保存成功。
 */
import {Dialog, getFrontend, Menu, Setting, showMessage} from "siyuan";
import {parseCustomHeaders} from "./api/headers";
import {listModels, testConnection} from "./api/client";
import {
    activeModelName,
    followDefaultTarget,
    providerModelNames,
    providerProtocol,
    readSiyuanProviders,
} from "./api/siyuan-provider";
import {
    AUTO_APPLY_ALWAYS,
    AUTO_APPLY_NEVER,
    AUTO_APPLY_OPTIONS,
    AUTO_APPLY_SINGLE,
    DEFAULT_SETTINGS,
    hasProviderConfig,
    hasProviderEndpoint,
    isAdapterProtocol,
    isFollowDefaultProvider,
    MEDIA_DROP,
    MEDIA_OPTIONS,
    MEDIA_PLACEHOLDER,
    MEDIA_RAW,
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_CHAT_COMPLETIONS,
    PROTOCOL_GEMINI_INTERACTIONS,
    PROTOCOL_RESPONSES,
    PROTOCOL_SIYUAN_PROVIDER,
    PROTOCOLS,
    PROVIDER_FOLLOW_AGENT,
    PROVIDER_FOLLOW_EDITOR,
    REASONING_DEFAULT,
    REASONING_EFFORT_OFF,
    REASONING_OPTIONS,
    TOC_ALWAYS,
    TOC_NEVER,
    TOC_OPTIONS,
    TOC_TRUNCATED,
    TRUNCATE_BOTH,
    TRUNCATE_FULL,
    TRUNCATE_HEAD,
    TRUNCATE_OPTIONS,
    TRUNCATE_TAIL,
    type AutoApply,
    type MediaMode,
    type PluginSettings,
    type ReasoningEffort,
    type TocMode,
    type TruncateMode,
} from "./config";
import {setDebug} from "./debug";
import {preheatPanel, skipFocusRestore} from "./dialog";
import type {T} from "./i18n";
import {canEncrypt} from "./secret";

/**
 * 供应商是否靠自己配的请求头鉴权（与思源自己的判定一致：
 * app/src/config/tabs/ai/aiProviderHeaders.ts 的 hasProviderHeaderAuth）。
 * 这类供应商的 API Key 本来就是空的，导入时不能因为它们「没填 key」就把它们筛掉。
 */
function hasHeaderAuth(headers: Record<string, string> | undefined): boolean {
    return Object.entries(headers ?? {}).some(([name, value]) =>
        ["authorization", "x-api-key", "api-key"].includes(name.toLowerCase()) && value.trim() !== "");
}

/** 请求头按 JSON 对象写进设置页的文本框；没有请求头时留空。 */
function formatHeaders(headers: Record<string, string> | undefined): string {
    return headers && Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : "";
}

/** 把配置写回本组各控件。导入会整体替换接口配置，届时需要重跑。 */
type Sync = () => void;

function input(className = "b3-text-field"): HTMLInputElement {
    const node = document.createElement("input");
    node.className = className;
    return node;
}

function select(): HTMLSelectElement {
    const node = document.createElement("select");
    node.className = "b3-select";
    return node;
}

function textarea(rows: number): HTMLTextAreaElement {
    const node = document.createElement("textarea");
    // 私有类名：文本域的尺寸规则要只落在本插件的文本框上
    node.className = "b3-text-field fn__block ai-title__textarea";
    node.rows = rows;
    return node;
}

/** 官方开关：b3-switch 必须落在 input 上，包一层 label 会同时画出原生复选框和畸形胶囊。 */
function switchControl(): HTMLInputElement {
    const node = document.createElement("input");
    node.type = "checkbox";
    node.className = "b3-switch fn__flex-center";
    return node;
}

function numberInput(step: number | "any" = "any"): HTMLInputElement {
    const node = input();
    node.type = "number";
    node.step = String(step);
    return node;
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[char] as string);
}

/** 上下键在可见条目间移动高亮，跳过被搜索过滤掉的。 */
function moveFocus(list: HTMLElement, event: KeyboardEvent): void {
    const items = Array.from(list.querySelectorAll<HTMLElement>(".b3-list-item"))
        .filter((item) => !item.classList.contains("fn__none"));
    if (items.length === 0) {
        return;
    }
    const current = items.findIndex((item) => item.classList.contains("b3-list-item--focus"));
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = items[(current + step + items.length) % items.length];
    items.forEach((item) => item.classList.remove("b3-list-item--focus"));
    next.classList.add("b3-list-item--focus");
    next.scrollIntoView({block: "nearest"});
    event.preventDefault();
    event.stopPropagation();
}

/**
 * 菜单关掉后把焦点还给模型输入框。
 *
 * 桌面端要还：键盘操作不该因为挑了个模型就断掉。
 *
 * 移动端不能还。App 把 `HTMLElement.prototype.focus` 重写过：只要焦点落到 `input` / `textarea`
 * 上就经原生桥接唤起软键盘（app/src/mobile/index.ts），键盘引起的 adjustResize 会改掉 WebView
 * 高度、整页跟着重排——重排正好落在菜单退场与重绘之间，界面上就是那一下闪烁。
 * 用户想继续改模型名，点一下输入框即可，不需要替他们弹键盘。
 */
function restoreAnchorFocus(anchor: HTMLInputElement): void {
    const frontend = getFrontend();
    if (frontend === "mobile" || frontend === "browser-mobile") {
        return;
    }
    anchor.focus();
}

/**
 * 模型选择器：点输入框弹出可搜索的下拉。
 *
 * 取自思源 AI 设置里选模型的实现（config/tabs/ai/aiProviderUi.ts 的 openAvailableModelMenu），
 * 那里用到的 upDownHint 与 escapeHTML 是应用内部工具，未随 SDK 导出，这里各写一份等价的。
 * 用 Menu 而不是 <select>：模型名允许任意填写，下拉只是省去手打的入口。
 */
function openModelMenu(anchor: HTMLInputElement, models: string[], t: T, onPick: (id: string) => void): void {
    const menu = new Menu();
    menu.addItem({
        iconHTML: "",
        type: "empty",
        label: `<div class="fn__flex-column b3-menu__filter ai-title__model-filter">
    <input class="b3-text-field fn__block" placeholder="${escapeHtml(t("modelSearch"))}">
    <div class="fn__hr"></div>
    <div class="b3-list fn__flex-1 b3-list--background">
        ${models.map((model) => `<div class="b3-list-item b3-list-item--narrow" data-model="${escapeHtml(model)}">
    <span class="b3-list-item__text">${escapeHtml(model)}</span>
    ${model === anchor.value ? '<svg class="b3-menu__checked"><use xlink:href="#iconSelect"></use></svg>' : ""}
</div>`).join("")}
        <div class="b3-list--empty fn__none" data-type="empty">${escapeHtml(t("modelEmpty"))}</div>
    </div>
</div>`,
        bind(element) {
            const list = element.querySelector<HTMLElement>(".b3-list");
            const search = element.querySelector<HTMLInputElement>("input");
            const empty = element.querySelector<HTMLElement>("[data-type='empty']");
            if (!list || !search || !empty) {
                return;
            }
            const select = (item: HTMLElement) => {
                const id = item.dataset.model ?? "";
                onPick(id);
                menu.close();
                restoreAnchorFocus(anchor);
            };
            const filter = () => {
                const keyword = search.value.toLowerCase().trim();
                let first: HTMLElement | undefined;
                list.querySelectorAll<HTMLElement>(".b3-list-item").forEach((item) => {
                    item.classList.remove("b3-list-item--focus");
                    const hidden = !(item.dataset.model ?? "").toLowerCase().includes(keyword);
                    item.classList.toggle("fn__none", hidden);
                    if (!hidden && !first) {
                        first = item;
                    }
                });
                first?.classList.add("b3-list-item--focus");
                empty.classList.toggle("fn__none", first !== undefined);
            };
            filter();
            search.addEventListener("keydown", (event: KeyboardEvent) => {
                event.stopPropagation();
                if (event.isComposing) {
                    return;
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    moveFocus(list, event);
                } else if (event.key === "Enter") {
                    const item = list.querySelector<HTMLElement>(".b3-list-item--focus");
                    if (item) {
                        select(item);
                    }
                    event.preventDefault();
                } else if (event.key === "Escape") {
                    menu.close();
                    restoreAnchorFocus(anchor);
                    event.preventDefault();
                }
            });
            search.addEventListener("input", () => {
                filter();
            });
            list.addEventListener("click", (event) => {
                const item = (event.target as HTMLElement).closest<HTMLElement>(".b3-list-item");
                if (item) {
                    select(item);
                }
            });
        },
    });
    const rect = anchor.getBoundingClientRect();
    menu.open({x: rect.left, y: rect.bottom, h: rect.height, w: rect.width});
    // Menu.open 的 w 只参与水平溢出修正，宽度实际由内容决定。思源那边的模型输入框只有
    // 二百来像素，窄面板不显眼；这里是整行铺满的输入框，菜单必须跟着同宽才不显得脱节。
    // border-box：.b3-menu 默认 content-box，直接给 width 会再叠上内边距
    menu.element.style.boxSizing = "border-box";
    menu.element.style.width = `${rect.width}px`;
}

function parseNumber(raw: string, fallback: number): number {
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function parsePositive(raw: string, fallback: number): number {
    return Math.max(1, parseNumber(raw, fallback));
}

/** 比例一律夹到 0 到 1，手滑输入 5 或 -1 时不该把额度算飞。 */
function parseRatio(raw: string, fallback: number): number {
    return Math.min(1, Math.max(0, parseNumber(raw, fallback)));
}

/** 空字符串代表「不发送该参数」，必须与数字 0 区分开。 */
function parseOptionalNumber(raw: string): number | null {
    if (raw.trim() === "") {
        return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

export interface SettingsPanelOptions {
    t: T;
    settings: PluginSettings;
    /** 确认后写回配置并重建界面入口。 */
    onSave: (next: PluginSettings) => Promise<void>;
}

/**
 * 面板里的一个控件句柄。
 *
 * 官方 `Setting` 是在打开面板时才现场建控件（`createActionElement`），所以初值不能在建控件时
 * 直接写死：元素拿到后统一走一次 sync，与「导入后重刷」共用同一条路径。
 * `element` 在面板打开之前是空的，按模式隐藏整行要等打开后再从它往上找行。
 */
interface Field {
    element?: HTMLElement;
}

/** 控件所属的整行。官方 Setting 没有隐藏 API，隐藏只能给这一行加 `fn__none`。 */
function rowOf(field: Field): HTMLElement | undefined {
    return field.element?.closest(".config-item") ?? undefined;
}

/** 按模式隐藏一条设置项：整行连标题与说明一起藏掉。 */
function hideRow(field: Field, hidden: boolean): void {
    rowOf(field)?.classList.toggle("fn__none", hidden);
}

/**
 * 加一条设置项。
 *
 * `build` 在面板打开时调用一次，控件必须在这一步完整建好并绑好事件：面板入场期间不再插入或
 * 替换内容，否则那一帧要重排，会闪旧画面。`direction` 为 `row` 时标题在上、控件占满整行
 * （文本域与「输入框 + 按钮」这类组合控件用），省略则标题在左、控件在右。
 */
function addField(setting: Setting, options: {
    title: string;
    description?: string;
    direction?: "row" | "column";
    build: () => HTMLElement;
}): Field {
    const field: Field = {};
    setting.addItem({
        title: options.title,
        description: options.description,
        direction: options.direction,
        createActionElement: () => {
            const element = options.build();
            field.element = element;
            return element;
        },
    });
    return field;
}

/**
 * 分组标题。
 *
 * 官方 `Setting.addItem` 只有平铺的设置项，没有分组概念。这里加一条不含控件的设置项当标题：
 * `createActionElement` 返回一个私有标记元素，样式（index.scss）据此把这一行渲染成思源设置页
 * 分组标题的样子，看上去是分组而不是一条设置项。标记元素本身只用来选中这一行，不显示。
 */
function addGroupTitle(setting: Setting, title: string): void {
    setting.addItem({
        title,
        direction: "row",
        createActionElement: () => {
            const marker = document.createElement("div");
            marker.className = "ai-title__group";
            return marker;
        },
    });
}

/**
 * 给官方面板的对话框预热图层。
 *
 * `Setting` 自己建对话框（新版移动端是 `MobileDialog` 抽屉），入场过渡仍是宿主的 scale + 淡入：
 * 图层不预热时，过渡起点与终点都要新建、销毁合成层，App 的 WebView 在拆层那一帧只能提交旧纹理。
 * `Setting.dialog` 运行时存在，`siyuan` 包的类型声明里还没有它 —— 只为这一处做窄类型扩展。
 */
/**
 * 给分组标题行补上类名。
 *
 * 样式（index.scss）据此把这一行渲染成思源设置页的分组标题。类名在面板打开后、第一帧绘制前
 * 补上（与下面写初值、按模式隐藏同一次同步流程），所以入场期间不会有样式层变动。
 */
function markGroupRows(setting: Setting): void {
    const dialog = (setting as Setting & {dialog?: Dialog}).dialog;
    dialog?.element.querySelectorAll(".ai-title__group").forEach((marker) => {
        marker.closest(".config-item")?.classList.add("ai-title__group-row");
    });
}

function preheatSetting(setting: Setting): void {
    const dialog = (setting as Setting & {dialog?: Dialog}).dialog;
    if (dialog) {
        preheatPanel(dialog);
    }
}

/**
 * 保存前拦住写坏的自定义请求头。
 *
 * 官方面板点保存是「先调确认回调、再关面板」，回调里抛错关不掉面板，用户刚改的内容会跟着消失。
 * 所以在动作栏上提前截住保存按钮这一次点击：JSON 解析不过就报错、不关面板，改完再存。
 * 输入框里按回车保存走的是同一个按钮，同样会被截住。取消按钮不经过这里。
 */
function guardSave(setting: Setting, t: T, settings: PluginSettings): void {
    const dialog = (setting as Setting & {dialog?: Dialog}).dialog;
    const action = dialog?.element.querySelector<HTMLElement>(".b3-dialog__action");
    action?.addEventListener("click", (event) => {
        const target = event.target as HTMLElement | null;
        const saveButton = target?.closest(".b3-button--text");
        if (!saveButton || !action.contains(saveButton)) {
            return;
        }
        try {
            parseCustomHeaders(settings.api.customHeaders);
        } catch (error) {
            event.preventDefault();
            event.stopPropagation();
            showMessage(
                t("saveFailed", {message: error instanceof Error ? error.message : String(error)}),
                12000,
                "error",
            );
        }
    }, true);
}

export function openSettingsPanel(options: SettingsPanelOptions): void {
    const {t} = options;
    // 复制一份，取消时不影响已保存的配置
    const settings: PluginSettings = structuredClone(options.settings);

    const setting = new Setting({
        confirmCallback: async () => {
            try {
                await options.onSave(settings);
            } catch (error) {
                // 确认回调无法否决关闭，至少把失败原因说清楚
                showMessage(
                    t("saveFailed", {message: error instanceof Error ? error.message : String(error)}),
                    12000,
                    "error",
                );
            }
        },
    });

    const syncs = [
        buildApiGroup(setting, t, settings),
        buildBehaviorGroup(setting, t, settings),
        buildUiGroup(setting, t, settings),
    ];

    // 移动端打开期间不聚焦输入控件。宿主 3.8.3～3.8.10-alpha.3 的 `Setting.open()` 结尾会对面板里
    // 第一个 `input, textarea` 补一次 `focus()`（app/src/plugin/Setting.ts），而 App 把
    // `HTMLElement.prototype.focus` 重写成经原生桥接唤起软键盘（app/src/mobile/index.ts），键盘引起的
    // adjustResize 会改掉 WebView 高度、整页重排，面板弹出的那一帧就闪旧画面。
    // 只包围这一段同步打开流程，打开结束立即还原：用户随后点输入框不经过这里，照常能输入。
    const frontend = getFrontend();
    const mobile = frontend === "mobile" || frontend === "browser-mobile";
    if (!mobile) {
        setting.open(t("pluginName"));
    } else {
        const prototype = HTMLElement.prototype;
        const originalFocus = prototype.focus;
        prototype.focus = function (this: HTMLElement, focusOptions?: FocusOptions) {
            // 对话框容器等非输入控件的聚焦照常放行，不会唤键盘
            if (!(this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement)) {
                originalFocus.call(this, focusOptions);
            }
        };
        try {
            setting.open(t("pluginName"));
        } finally {
            prototype.focus = originalFocus;
        }
    }
    // 同一个同步流程里补图层提示与分组标题类名，第一帧绘制之前就已生效
    preheatSetting(setting);
    markGroupRows(setting);

    // 初值：与导入后的重刷走同一条路径，避免两处逻辑漂移
    syncs.forEach((sync) => sync());

    guardSave(setting, t, settings);
}

function buildApiGroup(setting: Setting, t: T, settings: PluginSettings): Sync {
    addGroupTitle(setting, t("groupApi"));
    const {api} = settings;
    const syncs: Sync[] = [];

    /** 当前是不是「使用思源设置中供应商」模式（#27）。 */
    const siyuanMode = (): boolean => api.protocol === PROTOCOL_SIYUAN_PROVIDER;

    /**
     * 当前是不是「跟随编辑器默认」或「跟随智能体默认」（#28）。这两档下模型名由思源决定：
     * 插件这边既不能填、也不能从列表里挑。
     */
    const following = (): boolean => siyuanMode() && isFollowDefaultProvider(api.siyuanProvider);

    /**
     * 模型输入框该显示的名字。
     * 跟随默认时显示思源实际会用的那个模型，其余情况显示存下来的值。
     */
    const displayedModel = (): string => {
        if (!siyuanMode()) {
            return api.model;
        }
        return following() ? followDefaultTarget(api.siyuanProvider)?.model ?? "" : api.siyuanModel;
    };

    /** 跟随默认却解析不出模型时的占位文案：编辑器与智能体在思源里是两处设置，分开说。 */
    const followPlaceholder = (): string =>
        api.siyuanProvider.trim() === PROVIDER_FOLLOW_AGENT ? t("modelFollowEmptyAgent") : t("modelFollowEmptyEditor");

    /** 配置不全时的提示：两种模式缺的东西不是一回事。 */
    const missingConfigMessage = (): string => siyuanMode() ? t("testNoConfigProvider") : t("testNoConfig");

    let protocol: HTMLSelectElement | undefined;
    addField(setting, {
        title: t("protocol"),
        description: t("protocolDesc"),
        build: () => {
            const node = select();
            for (const value of PROTOCOLS) {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = protocolName(value, t);
                node.append(option);
            }
            node.addEventListener("change", () => {
                api.protocol = node.value as typeof api.protocol;
                // 模式换了：该显示的整行换一批，供应商下拉也要按思源当前的配置重建
                refresh();
            });
            protocol = node;
            return node;
        },
    });
    syncs.push(() => {
        if (protocol) {
            protocol.value = api.protocol;
        }
    });

    // 「获取模型列表」拉到的候选，供输入框点击时弹出（模型名本身仍允许直接手打）
    let availableModels: string[] = [];
    let modelInput: HTMLInputElement | undefined;
    let fetchButton: HTMLButtonElement | undefined;
    let provider: HTMLSelectElement | undefined;

    // 两种模式各有一个模型名字段：模型名只属于某一个供应商，共用一个字段会让切换模式时
    // 把一边的模型名带到另一边（见 config.ts 的 siyuanModel）
    const setModel = (id: string): void => {
        if (siyuanMode()) {
            api.siyuanModel = id;
        } else {
            api.model = id;
        }
        if (modelInput) {
            modelInput.value = id;
        }
    };

    // 模型名、获取列表与测试连接排在同一个控件里：三者都在改/验同一个模型名，
    // 分开几行时用户点完测试还要回头找输入框在哪（#18）
    addField(setting, {
        title: t("modelName"),
        description: t("modelNameDesc"),
        direction: "row",
        build: () => {
            const node = input();
            node.placeholder = t("modelPlaceholder");
            node.addEventListener("input", () => setModel(node.value));
            // 点输入框即可从已拉取的列表里挑
            node.addEventListener("click", () => {
                if (availableModels.length > 0) {
                    openModelMenu(node, availableModels, t, setModel);
                }
            });
            modelInput = node;

            const fetch = document.createElement("button");
            fetch.className = "b3-button b3-button--outline fn__flex-shrink";
            fetch.textContent = t("fetchModels");
            fetch.addEventListener("click", async () => {
                // 只要求端点：模型名是这次要拉的东西，不能反过来要求它已经填好
                if (!hasProviderEndpoint(api)) {
                    showMessage(missingConfigMessage(), 6000, "error");
                    return;
                }
                fetch.disabled = true;
                fetch.textContent = t("fetchModelsLoading");
                try {
                    const models = await listModels(api, settings.behavior.timeout);
                    if (models.length === 0) {
                        showMessage(t("testFailed", {message: "no models returned"}), 8000, "error");
                        return;
                    }
                    availableModels = models;
                    // 拉完直接摊开，省得再点一次输入框
                    openModelMenu(node, availableModels, t, setModel);
                } catch (error) {
                    showMessage(
                        t("testFailed", {message: error instanceof Error ? error.message : String(error)}),
                        12000,
                        "error",
                    );
                } finally {
                    fetch.disabled = false;
                    fetch.textContent = t("fetchModels");
                }
            });
            fetchButton = fetch;

            const test = document.createElement("button");
            test.className = "b3-button b3-button--outline fn__flex-shrink";
            test.textContent = t("testConnection");
            test.addEventListener("click", async () => {
                if (!hasProviderConfig(api)) {
                    showMessage(missingConfigMessage(), 6000, "error");
                    return;
                }
                test.disabled = true;
                test.textContent = t("testRunning");
                try {
                    const {reply, elapsed} = await testConnection(api, settings.behavior);
                    showMessage(t("testOk", {reply, elapsed}), 6000);
                } catch (error) {
                    showMessage(
                        t("testFailed", {message: error instanceof Error ? error.message : String(error)}),
                        12000,
                        "error",
                    );
                } finally {
                    test.disabled = false;
                    test.textContent = t("testConnection");
                }
            });

            const box = document.createElement("div");
            box.className = "ai-title-settings__field-row";
            box.append(node, fetch, test);
            return box;
        },
    });
    syncs.push(() => {
        if (modelInput) {
            modelInput.value = displayedModel();
        }
    });

    // 「使用思源设置中供应商」下唯一要在这里选的东西：插件只存这个 id，
    // 地址、密钥与请求头每次请求前从思源现取（#27）
    const providerField = addField(setting, {
        title: t("provider"),
        description: t("providerDesc"),
        build: () => {
            const node = select();
            node.addEventListener("change", () => {
                api.siyuanProvider = node.value;
                // 跟随默认时模型名也由思源决定，这里不写 siyuanModel（#28）。
                // 具体供应商则要跟着换模型：模型名只属于某个供应商，留着上一个的名字请求必然 404
                if (!following()) {
                    const chosen = readSiyuanProviders().find((item) => item.id === node.value);
                    if (chosen) {
                        setModel(activeModelName(chosen));
                        availableModels = providerModelNames(chosen);
                    }
                }
                // 整行该显示的换一批：跟随默认时模型名要变成只读
                refresh();
            });
            provider = node;
            return node;
        },
    });

    let baseURL: HTMLInputElement | undefined;
    const baseURLField = addField(setting, {
        title: t("baseUrl"),
        description: t("baseUrlDesc"),
        build: () => {
            const node = input();
            node.placeholder = "https://api.openai.com/v1";
            node.addEventListener("input", () => {
                api.baseURL = node.value;
            });
            baseURL = node;
            return node;
        },
    });
    syncs.push(() => {
        if (baseURL) {
            baseURL.value = api.baseURL;
        }
    });

    let apiKey: HTMLInputElement | undefined;
    // 拿不到思源数据仓库密钥时，这个 Key 只能明文落盘，必须当场说明（#26）：
    // 换成密码框之后用户没有任何办法从界面上看出它到底有没有被加密
    const apiKeyField = addField(setting, {
        title: t("apiKey"),
        description: canEncrypt() ? t("apiKeyDesc") : `${t("apiKeyDesc")} ${t("apiKeyDescInsecure")}`,
        build: () => {
            const node = input();
            node.type = "password";
            node.autocomplete = "off";
            node.addEventListener("input", () => {
                api.apiKey = node.value;
            });
            apiKey = node;
            return node;
        },
    });
    syncs.push(() => {
        if (apiKey) {
            apiKey.value = api.apiKey;
        }
    });

    // 与思源自己的供应商页面一样用一个 JSON 文本框：两边可以整段对拷，
    // 而「自定义请求头」这种名字与取值都不固定的东西列成表单反而更难看
    let customHeaders: HTMLTextAreaElement | undefined;
    const customHeadersField = addField(setting, {
        title: t("customHeaders"),
        description: t("customHeadersDesc"),
        direction: "row",
        build: () => {
            const node = textarea(3);
            node.spellcheck = false;
            node.placeholder = t("customHeadersPlaceholder");
            node.addEventListener("input", () => {
                api.customHeaders = node.value;
            });
            customHeaders = node;
            return node;
        },
    });
    syncs.push(() => {
        if (customHeaders) {
            customHeaders.value = api.customHeaders;
        }
    });

    const importField = addField(setting, {
        title: t("importFromSiyuan"),
        description: t("importFromSiyuanDesc"),
        build: () => {
            const node = document.createElement("button");
            node.className = "b3-button b3-button--outline";
            node.textContent = t("importFromSiyuan");
            node.addEventListener("click", () => {
                openImportDialog(t, settings, () => syncs.forEach((sync) => sync()));
            });
            return node;
        },
    });

    // 旧版这里是「从一串 JSON 片段里挑一条」的下拉，已撤出界面并弃用：
    // 其中 {"extra_body": ...} 在原始 HTTP 下永远不生效（extra_body 只是 Python SDK 的
    // 包装，SDK 发送前会把它拆开），其余几条各只对一个供应商有效，选错时还没有任何反馈。
    // 现在只发 OpenAI 官方的 reasoning_effort，取值与思源自己的 AI 设置一致。
    let reasoning: HTMLSelectElement | undefined;
    addField(setting, {
        title: t("reasoningEffort"),
        description: t("reasoningEffortDesc"),
        build: () => {
            const node = select();
            const reasoningLabels: Record<ReasoningEffort, string> = {
                [REASONING_EFFORT_OFF]: t("reasoningNone"),
                [REASONING_DEFAULT]: t("reasoningDefault"),
                low: t("reasoningLow"),
                medium: t("reasoningMedium"),
                high: t("reasoningHigh"),
                xhigh: t("reasoningXHigh"),
                max: t("reasoningMax"),
            };
            for (const value of REASONING_OPTIONS) {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = reasoningLabels[value];
                node.append(option);
            }
            node.addEventListener("change", () => {
                api.reasoningEffort = node.value as ReasoningEffort;
            });
            reasoning = node;
            return node;
        },
    });
    syncs.push(() => {
        if (reasoning) {
            reasoning.value = api.reasoningEffort;
        }
    });

    let temperature: HTMLInputElement | undefined;
    addField(setting, {
        title: t("temperature"),
        description: t("temperatureDesc"),
        build: () => {
            const node = numberInput(0.1);
            node.addEventListener("input", () => {
                api.temperature = parseNumber(node.value, DEFAULT_SETTINGS.api.temperature);
            });
            temperature = node;
            return node;
        },
    });
    syncs.push(() => {
        if (temperature) {
            temperature.value = String(api.temperature);
        }
    });

    let topP: HTMLInputElement | undefined;
    addField(setting, {
        title: t("topP"),
        description: t("topPDesc"),
        build: () => {
            const node = numberInput(0.05);
            node.addEventListener("input", () => {
                api.topP = parseOptionalNumber(node.value);
            });
            topP = node;
            return node;
        },
    });
    syncs.push(() => {
        if (topP) {
            topP.value = api.topP === null ? "" : String(api.topP);
        }
    });

    let topK: HTMLInputElement | undefined;
    addField(setting, {
        title: t("topK"),
        description: t("topKDesc"),
        build: () => {
            const node = numberInput();
            node.addEventListener("input", () => {
                api.topK = parseOptionalNumber(node.value);
            });
            topK = node;
            return node;
        },
    });
    syncs.push(() => {
        if (topK) {
            topK.value = api.topK === null ? "" : String(api.topK);
        }
    });

    let maxTokens: HTMLInputElement | undefined;
    addField(setting, {
        title: t("maxTokens"),
        description: t("maxTokensDesc"),
        build: () => {
            const node = numberInput();
            node.addEventListener("input", () => {
                api.maxTokens = parseNumber(node.value, DEFAULT_SETTINGS.api.maxTokens);
            });
            maxTokens = node;
            return node;
        },
    });
    syncs.push(() => {
        if (maxTokens) {
            maxTokens.value = String(api.maxTokens);
        }
    });

    /**
     * 模式切换后重刷可见性，并重建供应商下拉。
     *
     * 「使用思源设置中供应商」下 Base URL、API Key、自定义请求头与「从思源设置获取」
     * 都由思源那边接管了：在这里填只会让人以为生效了，导入更是会当场把模式切成自定义，
     * 所以整行隐藏；供应商下拉反过来只在该模式下出现。
     *
     * 「跟随编辑器/智能体默认」（#28）再多收两处：模型名由思源决定，
     * 输入框改成只读并显示思源实际会用的那个；「获取模型列表」也就没有意义了。
     */
    function refresh(): void {
        if (provider) {
            fillProviderOptions(provider, api.siyuanProvider, t);
        }
        const siyuan = siyuanMode();
        const follow = following();
        hideRow(baseURLField, siyuan);
        hideRow(apiKeyField, siyuan);
        hideRow(customHeadersField, siyuan);
        hideRow(importField, siyuan);
        hideRow(providerField, !siyuan);
        fetchButton?.classList.toggle("fn__none", follow);
        if (modelInput) {
            modelInput.disabled = follow;
            modelInput.placeholder = follow ? followPlaceholder() : t("modelPlaceholder");
            // 模型名跟着模式换：两种模式各存各的，切换时输入框要显示对应那一个
            modelInput.value = displayedModel();
        }
        if (follow) {
            availableModels = [];
        } else if (siyuan) {
            // 模型清单直接取思源里配好的那份：这个模式下模型本来就属于某个供应商
            const chosen = readSiyuanProviders().find((item) => item.id === api.siyuanProvider);
            availableModels = chosen ? providerModelNames(chosen) : [];
        } else {
            availableModels = [];
        }
    }
    syncs.push(refresh);

    return () => syncs.forEach((sync) => sync());
}

/** 协议标识 -> 展示名。认不出来的原样显示，至少让用户看到思源里存的是什么。 */
function protocolName(protocol: string, t: T): string {
    switch (protocol) {
        case PROTOCOL_SIYUAN_PROVIDER:
            return t("protocolSiyuanProvider");
        case PROTOCOL_CHAT_COMPLETIONS:
            return t("protocolChatCompletions");
        case PROTOCOL_RESPONSES:
            return t("protocolResponses");
        case PROTOCOL_ANTHROPIC_MESSAGES:
            return t("protocolAnthropicMessages");
        case PROTOCOL_GEMINI_INTERACTIONS:
            return t("protocolGeminiInteractions");
        default:
            return protocol;
    }
}

/**
 * 重建供应商下拉的选项。
 *
 * 每次重刷都整体重建：思源那边刚加了或删了供应商时，面板里留着上一次的列表，
 * 只会让人选到一个已经不存在的 id。
 *
 * 紧接着占位项的是两条「跟随默认」（#28）：「跟随编辑器默认」用思源里编辑器 AI 的
 * 默认模型，「跟随智能体默认」用智能体的。两者都不是供应商 id，所以排在具体供应商之前。
 */
function fillProviderOptions(node: HTMLSelectElement, selected: string, t: T): void {
    node.textContent = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t("providerPlaceholder");
    node.append(placeholder);

    for (const [value, label] of [
        [PROVIDER_FOLLOW_EDITOR, t("providerFollowEditor")],
        [PROVIDER_FOLLOW_AGENT, t("providerFollowAgent")],
    ] as const) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        node.append(option);
    }

    const providers = readSiyuanProviders();
    for (const provider of providers) {
        const id = provider.id ?? "";
        if (id === "") {
            continue;
        }
        const option = document.createElement("option");
        option.value = id;
        option.textContent = provider.displayName || id;
        node.append(option);
    }
    // 思源那边删掉的供应商原样留在下拉里：否则界面显示成没选，配置里却还留着旧 id，
    // 报错时用户看到的名字在界面上根本找不到
    if (selected !== "" && !isFollowDefaultProvider(selected) &&
        !providers.some((provider) => provider.id === selected)) {
        const missing = document.createElement("option");
        missing.value = selected;
        missing.textContent = selected;
        node.append(missing);
    }
    node.value = selected;
}

function buildBehaviorGroup(setting: Setting, t: T, settings: PluginSettings): Sync {
    addGroupTitle(setting, t("groupBehavior"));
    const {behavior} = settings;
    const syncs: Sync[] = [];

    let timeout: HTMLInputElement | undefined;
    addField(setting, {
        title: t("timeout"),
        description: t("timeoutDesc"),
        build: () => {
            const node = numberInput();
            node.addEventListener("input", () => {
                behavior.timeout = parseNumber(node.value, DEFAULT_SETTINGS.behavior.timeout);
            });
            timeout = node;
            return node;
        },
    });
    syncs.push(() => {
        if (timeout) {
            timeout.value = String(behavior.timeout);
        }
    });

    let retries: HTMLInputElement | undefined;
    addField(setting, {
        title: t("retries"),
        description: t("retriesDesc"),
        build: () => {
            const node = numberInput();
            node.addEventListener("input", () => {
                behavior.retries = parseNumber(node.value, DEFAULT_SETTINGS.behavior.retries);
            });
            retries = node;
            return node;
        },
    });
    syncs.push(() => {
        if (retries) {
            retries.value = String(behavior.retries);
        }
    });

    let contentLimit: HTMLInputElement | undefined;
    addField(setting, {
        title: t("contentLimit"),
        description: t("contentLimitDesc"),
        build: () => {
            const node = numberInput();
            node.addEventListener("input", () => {
                behavior.contentLimit = parseNumber(node.value, DEFAULT_SETTINGS.behavior.contentLimit);
            });
            contentLimit = node;
            return node;
        },
    });
    syncs.push(() => {
        if (contentLimit) {
            contentLimit.value = String(behavior.contentLimit);
        }
    });

    let truncateMode: HTMLSelectElement | undefined;
    addField(setting, {
        title: t("truncateMode"),
        description: t("truncateModeDesc"),
        build: () => {
            const node = select();
            const truncateLabels: Record<TruncateMode, string> = {
                [TRUNCATE_HEAD]: t("truncateHead"),
                [TRUNCATE_TAIL]: t("truncateTail"),
                [TRUNCATE_BOTH]: t("truncateBoth"),
                [TRUNCATE_FULL]: t("truncateFull"),
            };
            for (const value of TRUNCATE_OPTIONS) {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = truncateLabels[value];
                node.append(option);
            }
            node.addEventListener("change", () => {
                behavior.truncateMode = node.value as TruncateMode;
                syncRatio();
            });
            truncateMode = node;
            return node;
        },
    });

    // 比例必须紧跟在这条下拉下面：它只对「开头 + 末尾」一档有意义，
    // 中间隔着别的设置项时，用户看不出它在描述谁
    let headRatio: HTMLInputElement | undefined;
    const ratioField = addField(setting, {
        title: t("truncateHeadRatio"),
        description: t("truncateHeadRatioDesc"),
        build: () => {
            const node = numberInput(0.05);
            node.addEventListener("input", () => {
                behavior.truncateHeadRatio = parseRatio(node.value, DEFAULT_SETTINGS.behavior.truncateHeadRatio);
            });
            headRatio = node;
            return node;
        },
    });

    // 只在「开头 + 末尾」下显示，其余档位留着一个不起作用的输入框只会让人猜
    function syncRatio(): void {
        hideRow(ratioField, behavior.truncateMode !== TRUNCATE_BOTH);
    }

    syncs.push(() => {
        if (truncateMode) {
            truncateMode.value = behavior.truncateMode;
        }
        if (headRatio) {
            headRatio.value = String(behavior.truncateHeadRatio);
        }
        syncRatio();
    });

    let media: HTMLSelectElement | undefined;
    addField(setting, {
        title: t("mediaHandling"),
        description: t("mediaHandlingDesc"),
        build: () => {
            const node = select();
            const mediaLabels: Record<MediaMode, string> = {
                [MEDIA_DROP]: t("mediaDrop"),
                [MEDIA_PLACEHOLDER]: t("mediaPlaceholder"),
                [MEDIA_RAW]: t("mediaRaw"),
            };
            for (const value of MEDIA_OPTIONS) {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = mediaLabels[value];
                node.append(option);
            }
            node.addEventListener("change", () => {
                behavior.mediaMode = node.value as MediaMode;
            });
            media = node;
            return node;
        },
    });
    syncs.push(() => {
        if (media) {
            media.value = behavior.mediaMode;
        }
    });

    let includeTitle: HTMLInputElement | undefined;
    addField(setting, {
        title: t("includeTitle"),
        description: t("includeTitleDesc"),
        build: () => {
            const node = switchControl();
            node.addEventListener("change", () => {
                behavior.includeTitle = node.checked;
            });
            includeTitle = node;
            return node;
        },
    });
    syncs.push(() => {
        if (includeTitle) {
            includeTitle.checked = behavior.includeTitle;
        }
    });

    let tocMode: HTMLSelectElement | undefined;
    addField(setting, {
        title: t("tocMode"),
        description: t("tocModeDesc"),
        build: () => {
            const node = select();
            const tocLabels: Record<TocMode, string> = {
                [TOC_NEVER]: t("tocNever"),
                [TOC_TRUNCATED]: t("tocTruncated"),
                [TOC_ALWAYS]: t("tocAlways"),
            };
            for (const value of TOC_OPTIONS) {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = tocLabels[value];
                node.append(option);
            }
            node.addEventListener("change", () => {
                behavior.tocMode = node.value as TocMode;
            });
            tocMode = node;
            return node;
        },
    });
    syncs.push(() => {
        if (tocMode) {
            tocMode.value = behavior.tocMode;
        }
    });

    let batchSize: HTMLInputElement | undefined;
    addField(setting, {
        title: t("batchSize"),
        description: t("batchSizeDesc"),
        build: () => {
            const node = numberInput();
            node.addEventListener("input", () => {
                behavior.batchSize = parsePositive(node.value, DEFAULT_SETTINGS.behavior.batchSize);
            });
            batchSize = node;
            return node;
        },
    });
    syncs.push(() => {
        if (batchSize) {
            batchSize.value = String(behavior.batchSize);
        }
    });

    let concurrency: HTMLInputElement | undefined;
    addField(setting, {
        title: t("concurrency"),
        description: t("concurrencyDesc"),
        build: () => {
            const node = numberInput();
            node.addEventListener("input", () => {
                behavior.concurrency = parsePositive(node.value, DEFAULT_SETTINGS.behavior.concurrency);
            });
            concurrency = node;
            return node;
        },
    });
    syncs.push(() => {
        if (concurrency) {
            concurrency.value = String(behavior.concurrency);
        }
    });

    let autoApply: HTMLSelectElement | undefined;
    addField(setting, {
        title: t("autoApply"),
        description: t("autoApplyDesc"),
        build: () => {
            const node = select();
            const autoApplyLabels: Record<AutoApply, string> = {
                [AUTO_APPLY_NEVER]: t("autoApplyNever"),
                [AUTO_APPLY_SINGLE]: t("autoApplySingle"),
                [AUTO_APPLY_ALWAYS]: t("autoApplyAlways"),
            };
            for (const value of AUTO_APPLY_OPTIONS) {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = autoApplyLabels[value];
                node.append(option);
            }
            node.addEventListener("change", () => {
                behavior.autoApply = node.value as AutoApply;
            });
            autoApply = node;
            return node;
        },
    });
    syncs.push(() => {
        if (autoApply) {
            autoApply.value = behavior.autoApply;
        }
    });

    let language: HTMLInputElement | undefined;
    addField(setting, {
        title: t("titleLanguage"),
        description: t("titleLanguageDesc"),
        build: () => {
            const node = input();
            node.addEventListener("input", () => {
                behavior.titleLanguage = node.value;
            });
            language = node;
            return node;
        },
    });
    syncs.push(() => {
        if (language) {
            language.value = behavior.titleLanguage;
        }
    });

    let style: HTMLInputElement | undefined;
    addField(setting, {
        title: t("titleStyle"),
        description: t("titleStyleDesc"),
        build: () => {
            const node = input();
            node.addEventListener("input", () => {
                behavior.titleStyle = node.value;
            });
            style = node;
            return node;
        },
    });
    syncs.push(() => {
        if (style) {
            style.value = behavior.titleStyle;
        }
    });

    let ignoreInjection: HTMLInputElement | undefined;
    addField(setting, {
        title: t("ignoreInjection"),
        description: t("ignoreInjectionDesc"),
        build: () => {
            const node = switchControl();
            node.addEventListener("change", () => {
                behavior.ignoreInjection = node.checked;
            });
            ignoreInjection = node;
            return node;
        },
    });
    syncs.push(() => {
        if (ignoreInjection) {
            ignoreInjection.checked = behavior.ignoreInjection;
        }
    });

    let systemExtra: HTMLTextAreaElement | undefined;
    addField(setting, {
        title: t("systemExtra"),
        description: t("systemExtraDesc"),
        direction: "row",
        build: () => {
            const node = textarea(3);
            node.addEventListener("input", () => {
                behavior.systemExtra = node.value;
            });
            systemExtra = node;
            return node;
        },
    });
    syncs.push(() => {
        if (systemExtra) {
            systemExtra.value = behavior.systemExtra;
        }
    });

    let userExtra: HTMLTextAreaElement | undefined;
    addField(setting, {
        title: t("userExtra"),
        description: t("userExtraDesc"),
        direction: "row",
        build: () => {
            const node = textarea(3);
            node.addEventListener("input", () => {
                behavior.userExtra = node.value;
            });
            userExtra = node;
            return node;
        },
    });
    syncs.push(() => {
        if (userExtra) {
            userExtra.value = behavior.userExtra;
        }
    });

    return () => syncs.forEach((sync) => sync());
}

function buildUiGroup(setting: Setting, t: T, settings: PluginSettings): Sync {
    addGroupTitle(setting, t("groupUi"));
    const {ui} = settings;
    const syncs: Sync[] = [];

    let topBar: HTMLInputElement | undefined;
    addField(setting, {
        title: t("showTopBar"),
        description: t("showTopBarDesc"),
        build: () => {
            const node = switchControl();
            node.addEventListener("change", () => {
                ui.showTopBar = node.checked;
            });
            topBar = node;
            return node;
        },
    });
    syncs.push(() => {
        if (topBar) {
            topBar.checked = ui.showTopBar;
        }
    });

    let breadcrumb: HTMLInputElement | undefined;
    addField(setting, {
        title: t("showBreadcrumb"),
        description: t("showBreadcrumbDesc"),
        build: () => {
            const node = switchControl();
            node.addEventListener("change", () => {
                ui.showBreadcrumb = node.checked;
            });
            breadcrumb = node;
            return node;
        },
    });
    syncs.push(() => {
        if (breadcrumb) {
            breadcrumb.checked = ui.showBreadcrumb;
        }
    });

    let docTree: HTMLInputElement | undefined;
    addField(setting, {
        title: t("showDocTreeMenu"),
        description: t("showDocTreeMenuDesc"),
        build: () => {
            const node = switchControl();
            node.addEventListener("change", () => {
                ui.showDocTreeMenu = node.checked;
            });
            docTree = node;
            return node;
        },
    });
    syncs.push(() => {
        if (docTree) {
            docTree.checked = ui.showDocTreeMenu;
        }
    });

    let debugSwitch: HTMLInputElement | undefined;
    addField(setting, {
        title: t("debugMode"),
        description: t("debugModeDesc"),
        build: () => {
            const node = switchControl();
            node.addEventListener("change", () => {
                ui.debug = node.checked;
                // 立即生效，不必等保存后才能看到日志
                setDebug(node.checked);
            });
            debugSwitch = node;
            return node;
        },
    });
    syncs.push(() => {
        if (debugSwitch) {
            debugSwitch.checked = ui.debug;
        }
    });

    return () => syncs.forEach((sync) => sync());
}

function openImportDialog(t: T, settings: PluginSettings, onImported: () => void): void {
    const providers = readSiyuanProviders().filter((provider) =>
        (provider.baseURL ?? "") !== "" &&
        ((provider.apiKey ?? "") !== "" || hasHeaderAuth(provider.headers)));

    if (providers.length === 0) {
        showMessage(t("importEmpty"), 8000, "error");
        return;
    }

    // 导入窗是叠在设置面板之上的第二层弹窗（#46）。宿主 `Dialog` 构造时把当前焦点元素记成
    // `previousFocus`，关闭后再 `focus()` 回去（app/src/dialog/index.ts），而 App 把
    // `HTMLElement.prototype.focus` 重写成经原生桥接唤起软键盘：关窗那一刻弹键盘会让
    // WebView 重排，真机上表现为卡一下、甚至重载前端。
    // 先把焦点交给 body，再让宿主不留可恢复的目标 —— 关掉导入窗时不会再隐式聚焦面板里的控件。
    // 只改移动端：桌面端没有这条原生桥接，焦点照常还回去，键盘导航不受影响。
    const frontend = getFrontend();
    const mobile = frontend === "mobile" || frontend === "browser-mobile";
    if (mobile) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body) {
            active.blur();
        }
    }

    const dialog = new Dialog({
        title: t("importDialogTitle"),
        width: "640px",
        content: '<div class="b3-dialog__content"><div class="ai-title__importing"></div></div>',
    });
    preheatPanel(dialog);
    if (mobile) {
        skipFocusRestore(dialog);
    }
    const body = dialog.element.querySelector<HTMLElement>(".ai-title__importing");
    if (!body) {
        return;
    }

    for (const provider of providers) {
        const protocol = providerProtocol(provider);
        // 只接受插件实现了的协议：请求地址与请求体结构都按协议选，
        // 协议对不上时请求必然失败，不如在这里就把按钮禁掉
        const target = isAdapterProtocol(protocol) ? protocol : undefined;

        const item = document.createElement("div");
        item.className = "ai-title__import-item";

        const name = document.createElement("div");
        name.className = "ai-title__import-provider";
        name.textContent = provider.displayName || provider.id || "provider";

        const meta = document.createElement("div");
        meta.className = "ai-title__import-meta";
        // 协议类型必须显示出来：同一个供应商的 Anthropic 与 OpenAI 兼容端点
        // 是两个不同的 Base URL，光看地址分不出哪个是哪个
        meta.textContent = `${provider.baseURL} · ${activeModelName(provider) || "-"} · ${protocolName(protocol, t)}`;

        const choose = document.createElement("button");
        choose.className = "b3-button b3-button--outline";
        // 与打开本对话框的那个按钮区分开：这里点下去是把这一条配置导进来
        choose.textContent = target ? t("importApply") : t("importUnsupported");
        choose.disabled = target === undefined;
        if (!target) {
            // 禁用按钮点不出提示，把原因挂在 title 与 aria-label 上
            choose.title = t("importUnsupportedHint", {protocol: protocolName(protocol, t)});
            choose.setAttribute("aria-label", choose.title);
        }
        choose.addEventListener("click", () => {
            settings.api.baseURL = provider.baseURL ?? "";
            settings.api.apiKey = provider.apiKey ?? "";
            // 请求头一起带过来：靠自定义头鉴权、或要求会话头的供应商全靠它（#24）；
            // 供应商没配请求头时清空，导入是整体替换而不是叠加
            settings.api.customHeaders = formatHeaders(provider.headers);
            // 只取一个模型作为起点，用户仍可在设置页改或重新拉取列表
            settings.api.model = activeModelName(provider);
            // 协议跟着思源里的设置走，不写死：支持列表变了这里不用改
            if (target) {
                settings.api.protocol = target;
            }
            dialog.destroy();
            onImported();
        });

        const text = document.createElement("div");
        text.className = "ai-title__import-text";
        text.append(name, meta);

        item.append(text, choose);
        body.append(item);
    }
}

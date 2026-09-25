/**
 * 设置面板。
 *
 * 用 Dialog 而不是 Setting：Setting.addItem 只能把一个控件塞进一行，表达不了分组，
 * 分组标题会长得和普通设置项一模一样。这里按思源设置页自己的标记结构产出内容
 * （`.config` > `.config-title` + `.config-items`），直接复用那套样式规则；
 * 保存/取消按钮的搭法照抄 Setting 的实现，所以外观与行为一致。
 *
 * 控件只绑事件、不写初值：初值统一由各组返回的 sync 写入，
 * 与「导入后重刷」共用同一条路径。漏掉开头那次 sync 会让面板一律显示空白——
 * 存进去的配置看上去就像根本没保存成功。
 */
import {Dialog, Menu, showMessage} from "siyuan";
import {listModels, testConnection} from "./api/client";
import {
    AUTO_APPLY_ALWAYS,
    AUTO_APPLY_NEVER,
    AUTO_APPLY_OPTIONS,
    AUTO_APPLY_SINGLE,
    DEFAULT_SETTINGS,
    hasProviderConfig,
    MEDIA_DROP,
    MEDIA_OPTIONS,
    MEDIA_PLACEHOLDER,
    MEDIA_RAW,
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
import type {T} from "./i18n";

interface ProviderModel {
    id?: string;
    name?: string;
    displayName?: string;
    enabled?: boolean;
}

interface SiyuanProvider {
    id?: string;
    displayName?: string;
    baseURL?: string;
    apiKey?: string;
    protocol?: string;
    models?: ProviderModel[];
}

/**
 * 取供应商实际在用的模型名。
 *
 * 必须读 `name` 而不是 `id`：思源给每个模型也生成一个内部 id（形如 20260913135841-1u2j84c），
 * 那个字符串发到接口上是取不到模型的。
 * 一个供应商可以配多个模型，优先取启用中的那个。
 */
function activeModelName(provider: SiyuanProvider): string {
    const models = provider.models ?? [];
    const active = models.find((model) => model.enabled) ?? models[0];
    return active?.name ?? "";
}

/** 把配置写回本组各控件。导入会整体替换接口配置，届时需要重跑。 */
type Sync = () => void;

/**
 * 分组容器：与思源设置页同构（.config > .config-title + .config-items）。
 * 必须挂在 .config 之下，否则这些规则不生效。
 */
function createGroup(root: HTMLElement, title: string): HTMLElement {
    const heading = document.createElement("div");
    heading.className = "config-title";
    heading.textContent = title;

    const items = document.createElement("div");
    items.className = "config-items";

    root.append(heading, items);
    return items;
}

/** 设置项的标题与说明，两种布局共用。 */
function labelBlock(title: string, description: string): HTMLElement {
    const box = document.createElement("div");
    const name = document.createElement("div");
    name.className = "config-name";
    name.textContent = title;
    box.append(name);
    if (description !== "") {
        const text = document.createElement("div");
        text.className = "b3-label__text";
        text.textContent = description;
        box.append(text);
    }
    return box;
}

/**
 * 左标题右控件。
 * 开关交给思源自己渲染：Setting 见到含 b3-switch 的行会把它变成 label，
 * 整行可点即可切换；其余控件补 fn__size200 保持设置页统一的控件宽度。
 * 返回整行，便于调用方按条件隐藏（如「保留开头和末尾」才需要比例输入）。
 */
function rowItem(items: HTMLElement, title: string, description: string, field: HTMLElement): HTMLElement {
    const isSwitch = field.classList.contains("b3-switch");
    const row = document.createElement(isSwitch ? "label" : "div");
    row.className = "fn__flex b3-label config-item";

    const main = labelBlock(title, description);
    main.classList.add("fn__flex-1");

    const space = document.createElement("span");
    space.className = "fn__space";

    field.classList.add("fn__flex-center");
    if (!isSwitch) {
        field.classList.add("fn__size200");
    }

    row.append(main, space, field);
    items.append(row);
    return row;
}

/** 标题在上、控件占满整行。文本域和「下拉 + 附加输入」这类组合控件用这个。 */
function stackItem(items: HTMLElement, title: string, description: string, field: HTMLElement): void {
    const row = document.createElement("div");
    row.className = "b3-label config-item";

    const block = document.createElement("div");
    block.className = "fn__block";

    const space = document.createElement("div");
    space.className = "fn__hr";

    field.classList.add("fn__block");
    block.append(labelBlock(title, description), space, field);
    row.append(block);
    items.append(row);
}

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
    node.className = "b3-text-field fn__block";
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
                anchor.focus();
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
                    anchor.focus();
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

export function openSettingsPanel(options: SettingsPanelOptions): void {
    const {t} = options;
    // 复制一份，取消时不影响已保存的配置
    const settings: PluginSettings = structuredClone(options.settings);

    const dialog = new Dialog({
        title: t("pluginName"),
        // min() 让它在窄屏上自动收窄；桌面端就是 Setting 用的那个 768px
        width: "min(768px, 92vw)",
        // Setting 的默认高度，内容超出时由 .b3-dialog__content 滚动
        height: "80vh",
        content: '<div class="b3-dialog__content"><div class="config ai-title-settings"></div></div>' +
            '<div class="b3-dialog__action"></div>',
    });
    const root = dialog.element.querySelector<HTMLElement>(".ai-title-settings");
    const action = dialog.element.querySelector<HTMLElement>(".b3-dialog__action");
    if (!root || !action) {
        dialog.destroy();
        return;
    }

    const cancelButton = document.createElement("button");
    cancelButton.className = "b3-button b3-button--cancel";
    cancelButton.textContent = t("cancel");
    cancelButton.addEventListener("click", () => dialog.destroy());

    const space = document.createElement("div");
    space.className = "fn__space";

    const saveButton = document.createElement("button");
    saveButton.className = "b3-button b3-button--text";
    saveButton.textContent = t("save");
    saveButton.addEventListener("click", async () => {
        try {
            await options.onSave(settings);
        } catch (error) {
            // 保存失败就不关窗，否则用户刚改的内容会跟着对话框一起消失
            showMessage(
                t("saveFailed", {message: error instanceof Error ? error.message : String(error)}),
                12000,
                "error",
            );
            return;
        }
        dialog.destroy();
    });
    action.append(cancelButton, space, saveButton);

    const syncs = [
        buildApiGroup(root, t, settings),
        buildBehaviorGroup(root, t, settings),
        buildUiGroup(root, t, settings),
    ];
    // 初值：与导入后的重刷走同一条路径，避免两处逻辑漂移
    syncs.forEach((sync) => sync());

    // 自己搭对话框就得自己补上 Setting.addItem 会替我们做的那个 Ctrl+S
    dialog.element.addEventListener("keydown", (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            saveButton.click();
        }
    });
}

function buildApiGroup(root: HTMLElement, t: T, settings: PluginSettings): Sync {
    const items = createGroup(root, t("groupApi"));
    const {api} = settings;
    const syncs: Sync[] = [];

    const protocol = select();
    const chatOption = document.createElement("option");
    chatOption.value = "openai";
    chatOption.textContent = t("protocolChatCompletions");
    protocol.append(chatOption);
    protocol.addEventListener("change", () => {
        api.protocol = protocol.value;
    });
    syncs.push(() => {
        protocol.value = api.protocol;
    });
    rowItem(items, t("protocol"), t("protocolDesc"), protocol);

    const baseURL = input();
    baseURL.placeholder = "https://api.openai.com/v1";
    baseURL.addEventListener("input", () => {
        api.baseURL = baseURL.value;
    });
    syncs.push(() => {
        baseURL.value = api.baseURL;
    });
    rowItem(items, t("baseUrl"), t("baseUrlDesc"), baseURL);

    const apiKey = input();
    apiKey.type = "password";
    apiKey.autocomplete = "off";
    apiKey.addEventListener("input", () => {
        api.apiKey = apiKey.value;
    });
    syncs.push(() => {
        apiKey.value = api.apiKey;
    });
    rowItem(items, t("apiKey"), t("apiKeyDesc"), apiKey);

    // 已拉取到的模型名，供输入框的下拉使用；为空表示还没拉过
    let availableModels: string[] = [];

    const modelInput = input();
    modelInput.placeholder = t("modelPlaceholder");
    const pickModel = (id: string) => {
        api.model = id;
        modelInput.value = id;
    };
    modelInput.addEventListener("input", () => {
        api.model = modelInput.value;
    });
    // 点输入框即可从已拉取的列表里挑；模型名本身仍允许直接手打
    modelInput.addEventListener("click", () => {
        if (availableModels.length > 0) {
            openModelMenu(modelInput, availableModels, t, pickModel);
        }
    });
    syncs.push(() => {
        modelInput.value = api.model;
    });

    const fetchButton = document.createElement("button");
    fetchButton.className = "b3-button b3-button--outline fn__flex-shrink";
    fetchButton.textContent = t("fetchModels");
    fetchButton.addEventListener("click", async () => {
        if (api.baseURL.trim() === "") {
            showMessage(t("testNoConfig"), 6000, "error");
            return;
        }
        fetchButton.disabled = true;
        fetchButton.textContent = t("fetchModelsLoading");
        try {
            const models = await listModels(api, settings.behavior.timeout);
            if (models.length === 0) {
                showMessage(t("testFailed", {message: "no models returned"}), 8000, "error");
                return;
            }
            availableModels = models;
            // 拉完直接摊开，省得再点一次输入框
            openModelMenu(modelInput, availableModels, t, pickModel);
        } catch (error) {
            showMessage(t("testFailed", {message: error instanceof Error ? error.message : String(error)}), 12000, "error");
        } finally {
            fetchButton.disabled = false;
            fetchButton.textContent = t("fetchModels");
        }
    });

    const modelBox = document.createElement("div");
    modelBox.className = "ai-title-settings__field-row";
    modelBox.append(modelInput, fetchButton);
    stackItem(items, t("modelName"), t("modelNameDesc"), modelBox);

    const importButton = document.createElement("button");
    importButton.className = "b3-button b3-button--outline";
    importButton.textContent = t("importFromSiyuan");
    importButton.addEventListener("click", () => {
        openImportDialog(t, settings, () => syncs.forEach((sync) => sync()));
    });
    rowItem(items, t("importFromSiyuan"), t("importFromSiyuanDesc"), importButton);

    // 旧版这里是「从一串 JSON 片段里挑一条」的下拉，已撤出界面并弃用：
    // 其中 {"extra_body": ...} 在原始 HTTP 下永远不生效（extra_body 只是 Python SDK 的
    // 包装，SDK 发送前会把它拆开），其余几条各只对一个供应商有效，选错时还没有任何反馈。
    // 现在只发 OpenAI 官方的 reasoning_effort，取值与思源自己的 AI 设置一致。
    const reasoning = select();
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
        reasoning.append(option);
    }
    reasoning.addEventListener("change", () => {
        api.reasoningEffort = reasoning.value as ReasoningEffort;
    });
    syncs.push(() => {
        reasoning.value = api.reasoningEffort;
    });
    rowItem(items, t("reasoningEffort"), t("reasoningEffortDesc"), reasoning);

    const temperature = numberInput(0.1);
    temperature.addEventListener("input", () => {
        api.temperature = parseNumber(temperature.value, DEFAULT_SETTINGS.api.temperature);
    });
    syncs.push(() => {
        temperature.value = String(api.temperature);
    });
    rowItem(items, t("temperature"), t("temperatureDesc"), temperature);

    const topP = numberInput(0.05);
    topP.addEventListener("input", () => {
        api.topP = parseOptionalNumber(topP.value);
    });
    syncs.push(() => {
        topP.value = api.topP === null ? "" : String(api.topP);
    });
    rowItem(items, t("topP"), t("topPDesc"), topP);

    const topK = numberInput();
    topK.addEventListener("input", () => {
        api.topK = parseOptionalNumber(topK.value);
    });
    syncs.push(() => {
        topK.value = api.topK === null ? "" : String(api.topK);
    });
    rowItem(items, t("topK"), t("topKDesc"), topK);

    const maxTokens = numberInput();
    maxTokens.addEventListener("input", () => {
        api.maxTokens = parseNumber(maxTokens.value, DEFAULT_SETTINGS.api.maxTokens);
    });
    syncs.push(() => {
        maxTokens.value = String(api.maxTokens);
    });
    rowItem(items, t("maxTokens"), t("maxTokensDesc"), maxTokens);

    const testButton = document.createElement("button");
    testButton.className = "b3-button b3-button--outline";
    testButton.textContent = t("testConnection");
    testButton.addEventListener("click", async () => {
        if (!hasProviderConfig(api)) {
            showMessage(t("testNoConfig"), 6000, "error");
            return;
        }
        testButton.disabled = true;
        testButton.textContent = t("testRunning");
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
            testButton.disabled = false;
            testButton.textContent = t("testConnection");
        }
    });
    rowItem(items, t("testConnection"), t("testConnectionDesc"), testButton);

    return () => syncs.forEach((sync) => sync());
}

/** 从思源自身的 AI 供应商配置里一次性复制 Base URL / API Key / 模型。 */
function openImportDialog(t: T, settings: PluginSettings, onImported: () => void): void {
    const providers = readSiyuanProviders().filter((provider) =>
        (provider.apiKey ?? "") !== "" && (provider.baseURL ?? "") !== "");

    if (providers.length === 0) {
        showMessage(t("importEmpty"), 8000, "error");
        return;
    }

    const dialog = new Dialog({
        title: t("importDialogTitle"),
        width: "640px",
        content: '<div class="b3-dialog__content"><div class="ai-title__importing"></div></div>',
    });
    const body = dialog.element.querySelector<HTMLElement>(".ai-title__importing");
    if (!body) {
        return;
    }

    for (const provider of providers) {
        const item = document.createElement("div");
        item.className = "ai-title__import-item";

        const name = document.createElement("div");
        name.className = "ai-title__import-provider";
        name.textContent = provider.displayName || provider.id || "provider";

        const meta = document.createElement("div");
        meta.className = "ai-title__import-meta";
        meta.textContent = `${provider.baseURL} · ${activeModelName(provider) || "-"}`;

        const choose = document.createElement("button");
        choose.className = "b3-button b3-button--outline";
        // 与打开本对话框的那个按钮区分开：这里点下去是把这一条配置导进来
        choose.textContent = t("importApply");
        choose.addEventListener("click", () => {
            settings.api.baseURL = provider.baseURL ?? "";
            settings.api.apiKey = provider.apiKey ?? "";
            // 只取一个模型作为起点，用户仍可在设置页改或重新拉取列表
            settings.api.model = activeModelName(provider);
            settings.api.protocol = "openai";
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

/**
 * 读思源自己的 AI 配置。
 * 桌面端管理员角色下 apiKey 是明文；非管理员时内核会把 AI 配置整体清空，
 * 这时列表为空，界面给出「没有已配置的供应商」提示。
 */
function readSiyuanProviders(): SiyuanProvider[] {
    const config = (window as unknown as {siyuan?: {config?: {ai?: {providers?: SiyuanProvider[]}}}}).siyuan?.config;
    return config?.ai?.providers ?? [];
}

function buildBehaviorGroup(root: HTMLElement, t: T, settings: PluginSettings): Sync {
    const items = createGroup(root, t("groupBehavior"));
    const {behavior} = settings;
    const syncs: Sync[] = [];

    const timeout = numberInput();
    timeout.addEventListener("input", () => {
        behavior.timeout = parseNumber(timeout.value, DEFAULT_SETTINGS.behavior.timeout);
    });
    syncs.push(() => {
        timeout.value = String(behavior.timeout);
    });
    rowItem(items, t("timeout"), t("timeoutDesc"), timeout);

    const retries = numberInput();
    retries.addEventListener("input", () => {
        behavior.retries = parseNumber(retries.value, DEFAULT_SETTINGS.behavior.retries);
    });
    syncs.push(() => {
        retries.value = String(behavior.retries);
    });
    rowItem(items, t("retries"), t("retriesDesc"), retries);

    const contentLimit = numberInput();
    contentLimit.addEventListener("input", () => {
        behavior.contentLimit = parseNumber(contentLimit.value, DEFAULT_SETTINGS.behavior.contentLimit);
    });
    syncs.push(() => {
        contentLimit.value = String(behavior.contentLimit);
    });
    rowItem(items, t("contentLimit"), t("contentLimitDesc"), contentLimit);

    const truncateMode = select();
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
        truncateMode.append(option);
    }

    const headRatio = numberInput(0.05);
    headRatio.addEventListener("input", () => {
        behavior.truncateHeadRatio = parseRatio(headRatio.value, DEFAULT_SETTINGS.behavior.truncateHeadRatio);
    });
    const ratioRow = rowItem(items, t("truncateHeadRatio"), t("truncateHeadRatioDesc"), headRatio);
    // 比例只在「开头 + 末尾」下有意义，其余档位留着一个不起作用的输入框只会让人猜
    const syncRatio = (): void => {
        ratioRow.classList.toggle("fn__none", behavior.truncateMode !== TRUNCATE_BOTH);
    };

    truncateMode.addEventListener("change", () => {
        behavior.truncateMode = truncateMode.value as TruncateMode;
        syncRatio();
    });
    syncs.push(() => {
        truncateMode.value = behavior.truncateMode;
        headRatio.value = String(behavior.truncateHeadRatio);
        syncRatio();
    });
    rowItem(items, t("truncateMode"), t("truncateModeDesc"), truncateMode);

    const media = select();
    const mediaLabels: Record<MediaMode, string> = {
        [MEDIA_DROP]: t("mediaDrop"),
        [MEDIA_PLACEHOLDER]: t("mediaPlaceholder"),
        [MEDIA_RAW]: t("mediaRaw"),
    };
    for (const value of MEDIA_OPTIONS) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = mediaLabels[value];
        media.append(option);
    }
    media.addEventListener("change", () => {
        behavior.mediaMode = media.value as MediaMode;
    });
    syncs.push(() => {
        media.value = behavior.mediaMode;
    });
    rowItem(items, t("mediaHandling"), t("mediaHandlingDesc"), media);

    const includeTitle = switchControl();
    includeTitle.addEventListener("change", () => {
        behavior.includeTitle = includeTitle.checked;
    });
    syncs.push(() => {
        includeTitle.checked = behavior.includeTitle;
    });
    rowItem(items, t("includeTitle"), t("includeTitleDesc"), includeTitle);

    const tocMode = select();
    const tocLabels: Record<TocMode, string> = {
        [TOC_NEVER]: t("tocNever"),
        [TOC_TRUNCATED]: t("tocTruncated"),
        [TOC_ALWAYS]: t("tocAlways"),
    };
    for (const value of TOC_OPTIONS) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = tocLabels[value];
        tocMode.append(option);
    }
    tocMode.addEventListener("change", () => {
        behavior.tocMode = tocMode.value as TocMode;
    });
    syncs.push(() => {
        tocMode.value = behavior.tocMode;
    });
    rowItem(items, t("tocMode"), t("tocModeDesc"), tocMode);

    const batchSize = numberInput();
    batchSize.addEventListener("input", () => {
        behavior.batchSize = parsePositive(batchSize.value, DEFAULT_SETTINGS.behavior.batchSize);
    });
    syncs.push(() => {
        batchSize.value = String(behavior.batchSize);
    });
    rowItem(items, t("batchSize"), t("batchSizeDesc"), batchSize);

    const concurrency = numberInput();
    concurrency.addEventListener("input", () => {
        behavior.concurrency = parsePositive(concurrency.value, DEFAULT_SETTINGS.behavior.concurrency);
    });
    syncs.push(() => {
        concurrency.value = String(behavior.concurrency);
    });
    rowItem(items, t("concurrency"), t("concurrencyDesc"), concurrency);

    const autoApply = select();
    const autoApplyLabels: Record<AutoApply, string> = {
        [AUTO_APPLY_NEVER]: t("autoApplyNever"),
        [AUTO_APPLY_SINGLE]: t("autoApplySingle"),
        [AUTO_APPLY_ALWAYS]: t("autoApplyAlways"),
    };
    for (const value of AUTO_APPLY_OPTIONS) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = autoApplyLabels[value];
        autoApply.append(option);
    }
    autoApply.addEventListener("change", () => {
        behavior.autoApply = autoApply.value as AutoApply;
    });
    syncs.push(() => {
        autoApply.value = behavior.autoApply;
    });

    rowItem(items, t("autoApply"), t("autoApplyDesc"), autoApply);

    const language = input();
    language.addEventListener("input", () => {
        behavior.titleLanguage = language.value;
    });
    syncs.push(() => {
        language.value = behavior.titleLanguage;
    });
    rowItem(items, t("titleLanguage"), t("titleLanguageDesc"), language);

    const style = input();
    style.addEventListener("input", () => {
        behavior.titleStyle = style.value;
    });
    syncs.push(() => {
        style.value = behavior.titleStyle;
    });
    rowItem(items, t("titleStyle"), t("titleStyleDesc"), style);

    const systemExtra = textarea(3);
    systemExtra.addEventListener("input", () => {
        behavior.systemExtra = systemExtra.value;
    });
    syncs.push(() => {
        systemExtra.value = behavior.systemExtra;
    });
    stackItem(items, t("systemExtra"), t("systemExtraDesc"), systemExtra);

    const userExtra = textarea(3);
    userExtra.addEventListener("input", () => {
        behavior.userExtra = userExtra.value;
    });
    syncs.push(() => {
        userExtra.value = behavior.userExtra;
    });
    stackItem(items, t("userExtra"), t("userExtraDesc"), userExtra);

    return () => syncs.forEach((sync) => sync());
}

function buildUiGroup(root: HTMLElement, t: T, settings: PluginSettings): Sync {
    const items = createGroup(root, t("groupUi"));
    const {ui} = settings;
    const syncs: Sync[] = [];

    const topBar = switchControl();
    topBar.addEventListener("change", () => {
        ui.showTopBar = topBar.checked;
    });
    syncs.push(() => {
        topBar.checked = ui.showTopBar;
    });
    rowItem(items, t("showTopBar"), t("showTopBarDesc"), topBar);

    const breadcrumb = switchControl();
    breadcrumb.addEventListener("change", () => {
        ui.showBreadcrumb = breadcrumb.checked;
    });
    syncs.push(() => {
        breadcrumb.checked = ui.showBreadcrumb;
    });
    rowItem(items, t("showBreadcrumb"), t("showBreadcrumbDesc"), breadcrumb);

    const docTree = switchControl();
    docTree.addEventListener("change", () => {
        ui.showDocTreeMenu = docTree.checked;
    });
    syncs.push(() => {
        docTree.checked = ui.showDocTreeMenu;
    });
    rowItem(items, t("showDocTreeMenu"), t("showDocTreeMenuDesc"), docTree);

    const debugSwitch = switchControl();
    debugSwitch.addEventListener("change", () => {
        ui.debug = debugSwitch.checked;
        // 立即生效，不必等保存后才能看到日志
        setDebug(debugSwitch.checked);
    });
    syncs.push(() => {
        debugSwitch.checked = ui.debug;
    });
    rowItem(items, t("debugMode"), t("debugModeDesc"), debugSwitch);

    return () => syncs.forEach((sync) => sync());
}

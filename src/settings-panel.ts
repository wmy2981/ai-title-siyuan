/**
 * 设置面板。
 *
 * 思源的 Setting 类每项只能放一个 HTMLElement，也没有内建的逐项保存，
 * 所以每个控件都直接读写传入的 settings 对象，最后由 confirmCallback 统一落盘。
 *
 * 「从思源导入」会批量改写配置，因此各分组返回一个 refresh 回调，
 * 而不是去猜哪些控件需要同步。
 */
import {Dialog, Setting, showMessage} from "siyuan";
import {listModels, testConnection} from "./api/client";
import {
    AUTO_APPLY_ALWAYS,
    AUTO_APPLY_NEVER,
    AUTO_APPLY_OPTIONS,
    AUTO_APPLY_SINGLE,
    DEFAULT_SETTINGS,
    hasProviderConfig,
    THINKING_CUSTOM,
    THINKING_DISABLED,
    THINKING_PRESETS,
    type AutoApply,
    type PluginSettings,
} from "./config";
import {setDebug} from "./debug";
import type {T} from "./i18n";

interface ProviderModel {
    id?: string;
    name?: string;
    displayName?: string;
}

interface SiyuanProvider {
    id?: string;
    displayName?: string;
    baseURL?: string;
    apiKey?: string;
    protocol?: string;
    models?: ProviderModel[];
}

type Refresh = () => void;

function input(className = "b3-text-field fn__block"): HTMLInputElement {
    const node = document.createElement("input");
    node.className = className;
    node.style.minWidth = "260px";
    return node;
}

function select(): HTMLSelectElement {
    const node = document.createElement("select");
    node.className = "b3-select fn__block";
    node.style.minWidth = "260px";
    return node;
}

function textarea(rows: number): HTMLTextAreaElement {
    const node = document.createElement("textarea");
    node.className = "b3-text-field fn__block";
    node.rows = rows;
    node.style.minWidth = "260px";
    node.style.fontFamily = "var(--b3-font-family-code)";
    return node;
}

/** 思源的开关控件需要 label 包裹 input，这里返回可直接插入面板的 label。 */
function switchControl(checked: boolean, onChange: (value: boolean) => void): HTMLElement {
    const label = document.createElement("label");
    label.className = "fn__flex-center b3-switch";
    const node = document.createElement("input");
    node.type = "checkbox";
    node.checked = checked;
    node.addEventListener("change", () => onChange(node.checked));
    label.append(node);
    return label;
}

function numberInput(value: number | null, step: number | "any" = "any"): HTMLInputElement {
    const node = input();
    node.type = "number";
    node.step = String(step);
    node.value = value === null ? "" : String(value);
    return node;
}

function columnItem(setting: Setting, title: string, description: string, field: HTMLElement): void {
    setting.addItem({title, description, direction: "column", actionElement: field});
}

function rowItem(setting: Setting, title: string, description: string, field: HTMLElement): void {
    setting.addItem({title, description, actionElement: field});
}

function groupHeader(setting: Setting, title: string, description: string): void {
    setting.addItem({title, description, direction: "column", actionElement: document.createElement("div")});
}

function parseNumber(raw: string, fallback: number): number {
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function parsePositive(raw: string, fallback: number): number {
    return Math.max(1, parseNumber(raw, fallback));
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

/** 分组之间需要互相触发重刷：导入会整体替换接口配置。 */
interface PanelContext {
    t: T;
    settings: PluginSettings;
    setting: Setting;
    refreshAll: () => void;
}

export function openSettingsPanel(options: SettingsPanelOptions): void {
    const {t} = options;
    // 复制一份，取消时不影响已保存的配置
    const settings: PluginSettings = structuredClone(options.settings);

    const setting = new Setting({
        confirmCallback: async () => {
            await options.onSave(settings);
        },
    });

    const context: PanelContext = {t, settings, setting, refreshAll: () => undefined};
    const refreshers: Refresh[] = [
        buildApiGroup(context),
        buildBehaviorGroup(context),
        buildUiGroup(context),
    ];
    context.refreshAll = () => refreshers.forEach((refresh) => refresh());

    setting.open("ai-title-siyuan");
}

function buildApiGroup(context: PanelContext): Refresh {
    const {t, setting, settings} = context;
    const {api} = settings;
    groupHeader(setting, t("groupApi"), t("groupApiDesc"));

    const protocol = select();
    const chatOption = document.createElement("option");
    chatOption.value = "openai";
    chatOption.textContent = t("protocolChatCompletions");
    protocol.append(chatOption);
    protocol.addEventListener("change", () => {
        api.protocol = protocol.value;
    });
    rowItem(setting, t("protocol"), t("protocolDesc"), protocol);

    const baseURL = input();
    baseURL.placeholder = "https://api.openai.com/v1";
    baseURL.addEventListener("input", () => {
        api.baseURL = baseURL.value;
    });
    rowItem(setting, t("baseUrl"), t("baseUrlDesc"), baseURL);

    const apiKey = input();
    apiKey.type = "password";
    apiKey.autocomplete = "off";
    apiKey.addEventListener("input", () => {
        api.apiKey = apiKey.value;
    });
    rowItem(setting, t("apiKey"), t("apiKeyDesc"), apiKey);

    const modelInput = input();
    modelInput.placeholder = t("modelPlaceholder");
    modelInput.addEventListener("input", () => {
        api.model = modelInput.value;
    });

    const modelSelect = select();
    modelSelect.style.display = "none";
    modelSelect.addEventListener("change", () => {
        api.model = modelSelect.value;
        modelInput.value = modelSelect.value;
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
            modelSelect.replaceChildren();
            for (const id of models) {
                const option = document.createElement("option");
                option.value = id;
                option.textContent = id;
                modelSelect.append(option);
            }
            modelSelect.value = api.model || models[0];
            modelSelect.style.display = "";
        } catch (error) {
            showMessage(t("testFailed", {message: error instanceof Error ? error.message : String(error)}), 12000, "error");
        } finally {
            fetchButton.disabled = false;
            fetchButton.textContent = t("fetchModels");
        }
    });

    const modelBox = document.createElement("div");
    modelBox.className = "fn__flex";
    modelBox.style.gap = "8px";
    modelBox.style.flexWrap = "wrap";
    modelBox.append(modelInput, fetchButton, modelSelect);
    rowItem(setting, t("modelName"), t("modelNameDesc"), modelBox);

    const importButton = document.createElement("button");
    importButton.className = "b3-button b3-button--outline";
    importButton.textContent = t("importFromSiyuan");
    importButton.addEventListener("click", () => {
        openImportDialog(t, settings, context.refreshAll);
    });
    rowItem(setting, t("importFromSiyuan"), t("importFromSiyuanDesc"), importButton);

    const thinking = select();
    const thinkingLabels: Record<string, string> = {
        [THINKING_DISABLED]: t("thinkingDisabled"),
        [THINKING_CUSTOM]: t("thinkingCustom"),
    };
    for (const preset of THINKING_PRESETS) {
        const option = document.createElement("option");
        option.value = preset;
        // 预设项直接展示实际会发送的字段名，避免用户不知道点了什么
        option.textContent = thinkingLabels[preset] ?? preset;
        thinking.append(option);
    }
    const customThinking = textarea(2);
    customThinking.placeholder = '{"enable_thinking": false}';
    customThinking.style.marginTop = "8px";
    customThinking.addEventListener("input", () => {
        api.customThinking = customThinking.value;
    });

    thinking.addEventListener("change", () => {
        api.disableThinking = thinking.value;
        customThinking.style.display = thinking.value === THINKING_CUSTOM ? "" : "none";
    });

    const thinkingBox = document.createElement("div");
    thinkingBox.append(thinking, customThinking);
    columnItem(setting, t("disableThinking"), t("disableThinkingDesc"), thinkingBox);

    const temperature = numberInput(api.temperature, 0.1);
    temperature.addEventListener("input", () => {
        api.temperature = parseNumber(temperature.value, DEFAULT_SETTINGS.api.temperature);
    });
    rowItem(setting, t("temperature"), t("temperatureDesc"), temperature);

    const topP = numberInput(api.topP, 0.05);
    topP.addEventListener("input", () => {
        api.topP = parseOptionalNumber(topP.value);
    });
    rowItem(setting, t("topP"), t("topPDesc"), topP);

    const topK = numberInput(api.topK);
    topK.addEventListener("input", () => {
        api.topK = parseOptionalNumber(topK.value);
    });
    rowItem(setting, t("topK"), t("topKDesc"), topK);

    const maxTokens = numberInput(api.maxTokens);
    maxTokens.addEventListener("input", () => {
        api.maxTokens = parseNumber(maxTokens.value, DEFAULT_SETTINGS.api.maxTokens);
    });
    rowItem(setting, t("maxTokens"), t("maxTokensDesc"), maxTokens);

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
    rowItem(setting, t("testConnection"), t("testConnectionDesc"), testButton);

    return () => {
        protocol.value = api.protocol;
        baseURL.value = api.baseURL;
        apiKey.value = api.apiKey;
        modelInput.value = api.model;
        thinking.value = api.disableThinking;
        customThinking.value = api.customThinking;
        customThinking.style.display = api.disableThinking === THINKING_CUSTOM ? "" : "none";
        temperature.value = String(api.temperature);
        topP.value = api.topP === null ? "" : String(api.topP);
        topK.value = api.topK === null ? "" : String(api.topK);
        maxTokens.value = String(api.maxTokens);
    };
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

        const modelId = (provider.models ?? [])[0]?.id ?? "-";
        const meta = document.createElement("div");
        meta.className = "ai-title__import-meta";
        meta.textContent = `${provider.baseURL} · ${modelId}`;

        const choose = document.createElement("button");
        choose.className = "b3-button b3-button--outline";
        choose.textContent = t("importFromSiyuan");
        choose.addEventListener("click", () => {
            settings.api.baseURL = provider.baseURL ?? "";
            settings.api.apiKey = provider.apiKey ?? "";
            // 只取第一个模型作为起点，用户仍可在设置页改或重新拉取列表
            settings.api.model = (provider.models ?? [])[0]?.id ?? "";
            settings.api.protocol = "openai";
            dialog.destroy();
            onImported();
        });

        item.append(name, meta, choose);
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

function buildBehaviorGroup(context: PanelContext): Refresh {
    const {t, setting, settings} = context;
    const {behavior} = settings;
    groupHeader(setting, t("groupBehavior"), t("groupBehaviorDesc"));

    const timeout = numberInput(behavior.timeout);
    timeout.addEventListener("input", () => {
        behavior.timeout = parseNumber(timeout.value, DEFAULT_SETTINGS.behavior.timeout);
    });
    rowItem(setting, t("timeout"), t("timeoutDesc"), timeout);

    const retries = numberInput(behavior.retries);
    retries.addEventListener("input", () => {
        behavior.retries = parseNumber(retries.value, DEFAULT_SETTINGS.behavior.retries);
    });
    rowItem(setting, t("retries"), t("retriesDesc"), retries);

    const contentLimit = numberInput(behavior.contentLimit);
    contentLimit.addEventListener("input", () => {
        behavior.contentLimit = parseNumber(contentLimit.value, DEFAULT_SETTINGS.behavior.contentLimit);
    });
    rowItem(setting, t("contentLimit"), t("contentLimitDesc"), contentLimit);

    const batchSize = numberInput(behavior.batchSize);
    batchSize.addEventListener("input", () => {
        behavior.batchSize = parsePositive(batchSize.value, DEFAULT_SETTINGS.behavior.batchSize);
    });
    rowItem(setting, t("batchSize"), t("batchSizeDesc"), batchSize);

    const concurrency = numberInput(behavior.concurrency);
    concurrency.addEventListener("input", () => {
        behavior.concurrency = parsePositive(concurrency.value, DEFAULT_SETTINGS.behavior.concurrency);
    });
    rowItem(setting, t("concurrency"), t("concurrencyDesc"), concurrency);

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

    const autoApplyBox = document.createElement("div");
    autoApplyBox.append(autoApply);
    const autoApplyNote = document.createElement("div");
    autoApplyNote.className = "b3-label__text";
    autoApplyNote.style.marginTop = "8px";
    autoApplyNote.textContent = t("autoApplyBatchAlwaysAsk");
    autoApplyBox.append(autoApplyNote);
    columnItem(setting, t("autoApply"), t("autoApplyDesc"), autoApplyBox);

    const language = input();
    language.addEventListener("input", () => {
        behavior.titleLanguage = language.value;
    });
    rowItem(setting, t("titleLanguage"), t("titleLanguageDesc"), language);

    const style = input();
    style.addEventListener("input", () => {
        behavior.titleStyle = style.value;
    });
    rowItem(setting, t("titleStyle"), t("titleStyleDesc"), style);

    const systemPrompt = textarea(8);
    systemPrompt.addEventListener("input", () => {
        behavior.systemPrompt = systemPrompt.value;
    });
    columnItem(setting, t("systemPrompt"), t("systemPromptDesc"), systemPrompt);

    const userPrompt = textarea(7);
    userPrompt.addEventListener("input", () => {
        behavior.userPrompt = userPrompt.value;
    });
    columnItem(setting, t("userPrompt"), t("promptPlaceholders"), userPrompt);

    return () => {
        timeout.value = String(behavior.timeout);
        retries.value = String(behavior.retries);
        contentLimit.value = String(behavior.contentLimit);
        batchSize.value = String(behavior.batchSize);
        concurrency.value = String(behavior.concurrency);
        autoApply.value = behavior.autoApply;
        language.value = behavior.titleLanguage;
        style.value = behavior.titleStyle;
        systemPrompt.value = behavior.systemPrompt;
        userPrompt.value = behavior.userPrompt;
    };
}

function buildUiGroup(context: PanelContext): Refresh {
    const {t, setting, settings} = context;
    const {ui} = settings;
    groupHeader(setting, t("groupUi"), t("groupUiDesc"));

    const topBar = switchControl(ui.showTopBar, (value) => {
        ui.showTopBar = value;
    });
    rowItem(setting, t("showTopBar"), t("showTopBarDesc"), topBar);

    const breadcrumb = switchControl(ui.showBreadcrumb, (value) => {
        ui.showBreadcrumb = value;
    });
    rowItem(setting, t("showBreadcrumb"), t("showBreadcrumbDesc"), breadcrumb);

    const docTree = switchControl(ui.showDocTreeMenu, (value) => {
        ui.showDocTreeMenu = value;
    });
    rowItem(setting, t("showDocTreeMenu"), t("showDocTreeMenuDesc"), docTree);

    const debugSwitch = switchControl(ui.debug, (value) => {
        ui.debug = value;
        // 立即生效，不必等保存后才能看到日志
        setDebug(value);
    });
    rowItem(setting, t("debugMode"), t("debugModeDesc"), debugSwitch);

    return () => {
        (topBar.querySelector("input") as HTMLInputElement).checked = ui.showTopBar;
        (breadcrumb.querySelector("input") as HTMLInputElement).checked = ui.showBreadcrumb;
        (docTree.querySelector("input") as HTMLInputElement).checked = ui.showDocTreeMenu;
        (debugSwitch.querySelector("input") as HTMLInputElement).checked = ui.debug;
    };
}

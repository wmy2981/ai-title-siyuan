/**
 * 只在本设备生效的插件状态。
 *
 * 走内核的 local storage（`data/storage/local.json`，接口 `/api/storage/*LocalStorageVal`），
 * 而不是插件自己的 petal 数据，原因是两者的同步范围不同：
 * - petal（`plugin.loadData` / `saveData` 写的那份）**参与思源的数据同步** ——
 *   kernel/model/repository.go 对 `/storage/petal/` 的改动会重载插件并进入同步；
 * - `storage/local.json` **不参与同步** —— kernel/model/sync_ignore.go 把它列在忽略名单里。
 *
 * 为什么必须区分（#27）：「使用思源设置中供应商」选中的供应商 id 与模型名只在本设备成立。
 * 思源自己的 AI 供应商配置不参与同步，同一个 id 在别的设备上不存在；这两项要是跟着插件
 * 数据同步过去，那边的请求必然以「供应商不存在」失败。所以它们存在这里，各设备独立设置。
 */
import {fetchSyncPost} from "siyuan";
import type {PluginSettings} from "./config";
import {debug, debugError} from "./debug";

/** 本设备上选中的思源供应商与模型名。 */
export interface ProviderSelection {
    provider: string;
    model: string;
}

/** local storage 里的键名。带插件名前缀，免得和思源自己的键（layout、local-searchkeys…）撞车。 */
const SELECTION_KEY = "ai-title-siyuan-provider";

/** 只取内核响应里我们认识的那两个字段。 */
interface StorageResponse {
    code?: number;
    msg?: string;
    data?: unknown;
}

/**
 * 读本设备的选择。
 *
 * 没存过、读不到、或内核报错时一律返回 undefined —— 这只是「本设备还没选过」，
 * 不该拦住插件加载，设置页会显示成需要用户选一个。
 */
export async function loadProviderSelection(): Promise<ProviderSelection | undefined> {
    let response: StorageResponse;
    try {
        response = (await fetchSyncPost("/api/storage/getLocalStorageVal", {key: SELECTION_KEY})) as StorageResponse;
    } catch (error) {
        debugError("Failed to read the local provider selection", error);
        return undefined;
    }
    if (response?.code !== 0) {
        debugError("Failed to read the local provider selection", response?.msg ?? response?.code);
        return undefined;
    }
    const data = response.data;
    if (!data || typeof data !== "object") {
        return undefined;
    }
    const {provider, model} = data as {provider?: unknown; model?: unknown};
    const selection = {
        provider: typeof provider === "string" ? provider : "",
        model: typeof model === "string" ? model : "",
    };
    debug(`Local provider selection: "${selection.provider}" / "${selection.model}"`);
    return selection;
}

/**
 * 写本设备的选择。
 *
 * 写失败只记日志：它只影响「下次打开设置页还记不记得选过哪个供应商」，
 * 不该让一次设置保存整体失败。
 */
export async function saveProviderSelection(selection: ProviderSelection): Promise<void> {
    try {
        const response = (await fetchSyncPost("/api/storage/setLocalStorageVal", {
            key: SELECTION_KEY,
            val: selection,
        })) as StorageResponse;
        if (response?.code !== 0) {
            debugError("Failed to store the local provider selection", response?.msg ?? response?.code);
        }
    } catch (error) {
        debugError("Failed to store the local provider selection", error);
    }
}

/**
 * 落盘（petal，参与同步）用的配置：把只在本设备成立的两项清空，其余原样。
 *
 * 清空而不是留着：留着就会同步到别的设备，而那正是这个 bug 的成因。
 */
export function withoutProviderSelection(settings: PluginSettings): PluginSettings {
    const synced = structuredClone(settings);
    synced.api.siyuanProvider = "";
    synced.api.siyuanModel = "";
    return synced;
}

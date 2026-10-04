import {afterEach, describe, expect, it, vi} from "vitest";
import {DEFAULT_SETTINGS, PROTOCOL_CHAT_COMPLETIONS, type PluginSettings} from "../src/config";
import {canEncrypt, seal, sealSettings, unseal, unsealSettings} from "../src/secret";

/** 一份填好了 API Key 的配置。 */
function settingsWithKey(apiKey: string, apiKeyEncrypted = ""): PluginSettings {
    return {
        ...structuredClone(DEFAULT_SETTINGS),
        api: {
            ...DEFAULT_SETTINGS.api,
            protocol: PROTOCOL_CHAT_COMPLETIONS,
            baseURL: "https://api.example.com/v1",
            apiKey,
            apiKeyEncrypted,
        },
    };
}

/** 装一份假的宿主配置：真实环境里就是 window.siyuan.config（管理员角色下含数据仓库密钥）。 */
function setRepoKey(key: string | undefined): void {
    (globalThis as unknown as {window?: unknown}).window = {siyuan: {config: {repo: {key}}}};
}

/** 32 字节随机密钥的 base64，与思源里那份同形。 */
function randomRepoKey(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Buffer.from(bytes).toString("base64");
}

afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as unknown as {window?: unknown}).window;
});

describe("seal / unseal 信封（#26 用数据仓库密钥加密 API Key）", () => {
    it("有仓库密钥时能原样往返，且明文不出现在信封里", async () => {
        setRepoKey(randomRepoKey());
        expect(canEncrypt()).toBe(true);

        const envelope = await seal("sk-secret-value");
        expect(envelope).toBeDefined();
        expect(envelope).toMatch(/^v1:/);
        expect(envelope).not.toContain("sk-secret-value");
        await expect(unseal(envelope as string)).resolves.toBe("sk-secret-value");
    });

    it("每次加密的 IV 不同：同一份明文两次的信封不一样", async () => {
        setRepoKey(randomRepoKey());
        expect(await seal("same")).not.toBe(await seal("same"));
    });

    it("换了仓库密钥就解不开，且不抛错", async () => {
        setRepoKey(randomRepoKey());
        const envelope = (await seal("sk-secret-value")) as string;
        setRepoKey(randomRepoKey());
        await expect(unseal(envelope)).resolves.toBeUndefined();
    });

    it("没有仓库密钥时不加密，也解不开", async () => {
        setRepoKey("");
        expect(canEncrypt()).toBe(false);
        await expect(seal("sk-secret-value")).resolves.toBeUndefined();

        setRepoKey(randomRepoKey());
        const envelope = (await seal("sk-secret-value")) as string;
        setRepoKey("");
        await expect(unseal(envelope)).resolves.toBeUndefined();
    });

    it("非 base64、空串、非三段的信封一律按解不开处理", async () => {
        setRepoKey(randomRepoKey());
        await expect(unseal("")).resolves.toBeUndefined();
        await expect(unseal("v2:AAAA:BBBB")).resolves.toBeUndefined();
        await expect(unseal("v1:不是base64:也不是")).resolves.toBeUndefined();
        await expect(unseal("v1:AAAA")).resolves.toBeUndefined();
    });
});

describe("sealSettings / unsealSettings（#26 的落盘与迁移）", () => {
    it("落盘只有密文：明文 Key 被换成 apiKeyEncrypted，apiKey 留空", async () => {
        setRepoKey(randomRepoKey());
        const sealed = await sealSettings(settingsWithKey("sk-secret-value"));
        expect(sealed.api.apiKey).toBe("");
        expect(sealed.api.apiKeyEncrypted).toMatch(/^v1:/);

        const {settings, needsWrite, unreadable} = await unsealSettings(sealed);
        expect(settings.api.apiKey).toBe("sk-secret-value");
        expect(settings.api.apiKeyEncrypted).toBe("");
        expect(needsWrite).toBe(false);
        expect(unreadable).toBe(false);
    });

    it("取不到仓库密钥时退回明文存储，读回来原样可用", async () => {
        setRepoKey("");
        const sealed = await sealSettings(settingsWithKey("sk-secret-value"));
        expect(sealed.api.apiKey).toBe("sk-secret-value");
        expect(sealed.api.apiKeyEncrypted).toBe("");
        // 已经没有可加密的条件，也就不需要回写
        await expect(unsealSettings(sealed)).resolves.toMatchObject({
            needsWrite: false,
            unreadable: false,
            settings: {api: {apiKey: "sk-secret-value"}},
        });
    });

    it("旧版的明文 Key 会被迁移：标记需要回写，回写后就是密文", async () => {
        setRepoKey(randomRepoKey());
        const legacy = await unsealSettings(settingsWithKey("sk-secret-value"));
        expect(legacy.settings.api.apiKey).toBe("sk-secret-value");
        expect(legacy.needsWrite).toBe(true);
        expect(legacy.unreadable).toBe(false);

        const migrated = await sealSettings(legacy.settings);
        expect(migrated.api.apiKey).toBe("");
        const again = await unsealSettings(migrated);
        expect(again.settings.api.apiKey).toBe("sk-secret-value");
        expect(again.needsWrite).toBe(false);
    });

    it("解不开时清空 Key 并标记，而不是抛错（用户重置过数据仓库密钥）", async () => {
        setRepoKey(randomRepoKey());
        const sealed = await sealSettings(settingsWithKey("sk-secret-value"));
        setRepoKey(randomRepoKey());

        const {settings, needsWrite, unreadable} = await unsealSettings(sealed);
        expect(settings.api.apiKey).toBe("");
        expect(settings.api.apiKeyEncrypted).toBe("");
        expect(needsWrite).toBe(true);
        expect(unreadable).toBe(true);
    });

    it("数据仓库密钥整个没了（未初始化、或被重置掉）时同样按解不开处理", async () => {
        setRepoKey(randomRepoKey());
        const sealed = await sealSettings(settingsWithKey("sk-secret-value"));
        setRepoKey("");

        const {settings, needsWrite, unreadable} = await unsealSettings(sealed);
        expect(settings.api.apiKey).toBe("");
        expect(settings.api.apiKeyEncrypted).toBe("");
        expect(needsWrite).toBe(true);
        expect(unreadable).toBe(true);
    });

    it("没有 WebCrypto 的环境里密文原样留着（浏览器经 http://局域网 IP 打开思源）", async () => {
        setRepoKey(randomRepoKey());
        const sealed = await sealSettings(settingsWithKey("sk-secret-value"));
        // 非安全上下文里 crypto.subtle 是 undefined，这时不是「解不开」而是「这里解不了」
        vi.stubGlobal("crypto", {});

        expect(canEncrypt()).toBe(false);
        const {settings, needsWrite, unreadable} = await unsealSettings(sealed);
        expect(settings.api.apiKey).toBe("");
        expect(settings.api.apiKeyEncrypted).toBe(sealed.api.apiKeyEncrypted);
        expect(needsWrite).toBe(false);
        expect(unreadable).toBe(false);
        // 落盘时同样不能把它抹掉：抹掉是不可逆的，而换个环境还能解开
        expect((await sealSettings(settings)).api.apiKeyEncrypted).toBe(sealed.api.apiKeyEncrypted);
    });

    it("用户清空 Key 之后落盘不再有密文", async () => {
        setRepoKey(randomRepoKey());
        const sealed = await sealSettings(settingsWithKey("sk-secret-value"));
        // 读回来时密文就已经被清掉了，用户在设置页里把 Key 删掉再保存
        const opened = await unsealSettings(sealed);
        expect(opened.settings.api.apiKeyEncrypted).toBe("");
        const saved = await sealSettings({...opened.settings, api: {...opened.settings.api, apiKey: ""}});
        expect(saved.api.apiKey).toBe("");
        expect(saved.api.apiKeyEncrypted).toBe("");
    });

    it("没填 Key 的配置既不需要回写，也不会被当成解不开", async () => {
        setRepoKey(randomRepoKey());
        await expect(unsealSettings(settingsWithKey(""))).resolves.toMatchObject({
            needsWrite: false,
            unreadable: false,
        });
    });
});

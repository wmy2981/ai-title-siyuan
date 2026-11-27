/**
 * API Key 的落盘加密。
 *
 * 明文只存在于内存与设置页里：配置写进插件数据目录之前先换成一个 AES-GCM 信封，
 * 读回来时再解回明文。密钥取自思源自己的**数据仓库密钥** —— 那是 32 字节随机数，
 * 以 base64 存在 `window.siyuan.config.repo.key`，管理员角色下内核原样返回
 * （kernel/model/conf.go 的 GetMaskedConf 只清 MCPOAuth / CookieKey / AccessAuthCode）。
 *
 * 三件必须说清楚的事：
 * 1. **思源不会自动生成数据仓库密钥**。只有用户在「设置 → 数据仓库密钥」里初始化或导入过、
 *    或开通云同步时才存在，否则它为空串，此时无法加密，插件退回明文存储并在设置页说明
 *    （见 canEncrypt）。
 * 2. **解不开不是错误**。用户重置或更换过数据仓库密钥后旧密文再也解不开，这时按「清空 Key」
 *    处理并提示一次，而不是抛错 —— 抛错会让插件卡在一条用户自己无法修复的报错上。
 * 3. 换算法只加新的信封前缀，不认识的前缀一律按「解不开」处理。
 *
 * 加密在渲染进程里做：插件运行在思源的窗口里，用的是宿主自带的 WebCrypto，
 * 不引第三方库（打包契约要求 CommonJS，而且没必要为此多带一份实现）。
 */
import type {PluginSettings} from "./config";

/** 信封格式版本，形如 `v1:<iv>:<ciphertext>`，两段都是 base64。 */
const ENVELOPE_VERSION = "v1";
/** HKDF 的域分离标签：思源自己拿这把密钥做的是 AES-CBC 快照加密，两边不该共用同一把成品密钥。 */
const HKDF_INFO = "ai-title-siyuan/api-key";
/** AES-GCM 的 IV 长度，规范推荐的 96 位。 */
const IV_BYTES = 12;
/** GCM 的认证标签长度（位），WebCrypto 的默认值，写出来是为了让格式一目了然。 */
const TAG_BITS = 128;

/** 宿主配置里我们用到的那一小部分：只有数据仓库密钥。 */
interface SiYuanConfig {
    repo?: {key?: string};
}

function siyuanConfig(): SiYuanConfig | undefined {
    if (typeof window === "undefined") {
        // 单元测试没有宿主，按「取不到密钥」处理
        return undefined;
    }
    return (window as unknown as {siyuan?: {config?: SiYuanConfig}}).siyuan?.config;
}

/** 数据仓库密钥的 base64 文本；没初始化过、或当前角色读不到时是空串。 */
function repoKeyBase64(): string {
    return (siyuanConfig()?.repo?.key ?? "").trim();
}

function webcrypto(): SubtleCrypto | undefined {
    return typeof crypto === "undefined" ? undefined : crypto.subtle;
}

/**
 * 能不能加密。设置页据此决定是否提示「Key 以明文保存」。
 * 两个条件：宿主持有数据仓库密钥，且运行环境提供 WebCrypto。
 */
export function canEncrypt(): boolean {
    return hasRepoKey() && hasWebCrypto();
}

/** 宿主有没有给出数据仓库密钥。没初始化过、或当前角色读不到时为 false。 */
function hasRepoKey(): boolean {
    return repoKeyBase64() !== "";
}

/**
 * 运行环境有没有 WebCrypto。
 *
 * 非安全上下文里 `crypto.subtle` 是 undefined —— 通过 `http://局域网 IP:6806`
 * 用浏览器打开的思源就是这种情况（`http://127.0.0.1` 与桌面端都算安全上下文）。
 * 这时密文不是「解不开」，而是「这里解不了」，必须与密钥被换掉区分开。
 */
function hasWebCrypto(): boolean {
    return webcrypto() !== undefined;
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

/**
 * 数据仓库密钥 → 本次加密用的 AES-GCM 密钥。
 * 取不到密钥、密钥不是合法 base64、或环境没有 WebCrypto 时返回 undefined，绝不抛错。
 */
async function deriveKey(): Promise<CryptoKey | undefined> {
    const subtle = webcrypto();
    const raw = repoKeyBase64();
    if (!subtle || raw === "") {
        return undefined;
    }
    try {
        const key = fromBase64(raw);
        if (key.length === 0) {
            return undefined;
        }
        // HKDF 而不是直接拿仓库密钥当 AES 密钥：同一份密钥材料用在不同地方时，
        // 域分离能保证两边的成品密钥互不相干
        const material = await subtle.importKey("raw", key, "HKDF", false, ["deriveKey"]);
        return await subtle.deriveKey(
            {name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO)},
            material,
            {name: "AES-GCM", length: 256},
            false,
            ["encrypt", "decrypt"],
        );
    } catch {
        return undefined;
    }
}

/** 明文 → 信封文本。不能加密或加密失败时返回 undefined，由调用方按明文回退处理。 */
export async function seal(plain: string): Promise<string | undefined> {
    const subtle = webcrypto();
    const key = await deriveKey();
    if (!subtle || !key) {
        return undefined;
    }
    try {
        const iv = new Uint8Array(IV_BYTES);
        crypto.getRandomValues(iv);
        const ciphertext = new Uint8Array(
            await subtle.encrypt({name: "AES-GCM", iv, tagLength: TAG_BITS}, key, new TextEncoder().encode(plain)),
        );
        return `${ENVELOPE_VERSION}:${toBase64(iv)}:${toBase64(ciphertext)}`;
    } catch {
        return undefined;
    }
}

/** 信封文本 → 明文。任何异常都返回 undefined：调用方按「解不开」处理，不往外抛。 */
export async function unseal(envelope: string): Promise<string | undefined> {
    const parts = envelope.split(":");
    if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) {
        return undefined;
    }
    const subtle = webcrypto();
    const key = await deriveKey();
    if (!subtle || !key) {
        return undefined;
    }
    try {
        const plain = await subtle.decrypt(
            {name: "AES-GCM", iv: fromBase64(parts[1]), tagLength: TAG_BITS},
            key,
            fromBase64(parts[2]),
        );
        return new TextDecoder().decode(plain);
    } catch {
        return undefined;
    }
}

/** 读回配置的结果。 */
export interface UnsealedSettings {
    settings: PluginSettings;
    /** 是否需要立刻回写：旧版的明文 Key 迁移成密文，或解不开的 Key 被清空。 */
    needsWrite: boolean;
    /** 密文解不开（数据仓库密钥被重置或更换）。调用方据此提示用户一次。 */
    unreadable: boolean;
}

/**
 * 落盘前的配置：明文 API Key 换成密文；拿不到数据仓库密钥时退回明文。
 *
 * 明文为空时原样返回，不动密文：用户主动清空 Key 的情况下，密文在读回来时就已经
 * 被清掉了（见 unsealSettings），而这里还留着密文只可能是「这个环境解不了」，
 * 那种密文必须留住 —— 抹掉是不可逆的。
 */
export async function sealSettings(settings: PluginSettings): Promise<PluginSettings> {
    const sealed = structuredClone(settings);
    if (sealed.api.apiKey === "") {
        return sealed;
    }
    const envelope = await seal(sealed.api.apiKey);
    if (envelope === undefined) {
        sealed.api.apiKeyEncrypted = "";
        return sealed;
    }
    sealed.api.apiKey = "";
    sealed.api.apiKeyEncrypted = envelope;
    return sealed;
}

/**
 * 读回后的配置：密文解回明文；解不开时清空 Key 并标记，绝不抛错。
 *
 * 内存里不保留密文：留着它，下一次保存就可能把一份已经无效的密文写回去。
 * 唯一的例外是环境本身没有 WebCrypto —— 那不是密文无效，是这里解不了。
 */
export async function unsealSettings(settings: PluginSettings): Promise<UnsealedSettings> {
    const unsealed = structuredClone(settings);
    const envelope = unsealed.api.apiKeyEncrypted;
    unsealed.api.apiKeyEncrypted = "";
    if (envelope === "") {
        // 没有密文：要么本来就没存 Key，要么是旧版存下的明文，后者需要迁移一次
        return {settings: unsealed, needsWrite: unsealed.api.apiKey !== "" && canEncrypt(), unreadable: false};
    }
    if (!hasWebCrypto()) {
        // 这里没有 WebCrypto，密文留着别动：换个环境（桌面端、127.0.0.1）还能解开。
        // 设置页此时本来就提示「以明文保存」，用户重新填一次就会覆盖掉这份密文
        unsealed.api.apiKeyEncrypted = envelope;
        return {settings: unsealed, needsWrite: false, unreadable: false};
    }
    const plain = await unseal(envelope);
    if (plain === undefined) {
        unsealed.api.apiKey = "";
        return {settings: unsealed, needsWrite: true, unreadable: true};
    }
    unsealed.api.apiKey = plain;
    return {settings: unsealed, needsWrite: false, unreadable: false};
}

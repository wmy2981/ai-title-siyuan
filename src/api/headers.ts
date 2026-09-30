/**
 * 自定义请求头：解析配置、替换思源变量与密钥、并与协议自带的头合并。
 *
 * 为什么占位符要在这里替换：插件经 `/api/network/forwardProxy` 发请求，内核只把
 * headers 原样转交，**不会**替换 `{{vars.NAME}}` / `{{secrets.NAME}}` ——
 * 那是内核给自己那套 AI 客户端做的事（kernel/model/ai_headers.go）。因此自定义头里
 * 的引用文本必须由插件自己解析；这也是「opencode 这类要求自定义请求头的供应商」
 * 能用的前提（#24）。
 *
 * 每次请求前都重新解析：变量可以被别的插件按会话改写（如 opencode-go-siyuan 每段
 * 对话写一次会话 ID），存下来的只是引用文本。
 */
import type {ApiSettings} from "../config";
import {ApiError, hostOf} from "./protocol";

/** 思源「设置 → 密钥和变量」里的一条密钥。 */
interface SiyuanSecret {
    name?: string;
    /** 内核已解密，只有本地管理员读得到明文。 */
    value?: string;
    /** 允许插值到的主机名列表，空列表等于不允许任何主机。 */
    allowedHosts?: string[];
}

/** 思源「设置 → 密钥和变量」里的一条变量。 */
interface SiyuanVariable {
    name?: string;
    value?: string;
}

interface SiyuanConfig {
    secrets?: {items?: SiyuanSecret[]};
    variables?: {items?: SiyuanVariable[]};
}

/**
 * 思源自己的密钥库与变量库。
 *
 * 发布服务访客等非管理员角色下，内核把两者连同供应商请求头一起清空
 * （kernel/api/system.go 的 HideConfSecret），此时这里读到 undefined，
 * 占位符原样留在请求头里 —— 比悄悄发一个空值好查。
 */
function siyuanConfig(): SiyuanConfig | undefined {
    if (typeof window === "undefined") {
        // 单元测试没有宿主，按「查不到名字」处理
        return undefined;
    }
    return (window as unknown as {siyuan?: {config?: SiyuanConfig}}).siyuan?.config;
}

/** `{{vars.NAME}}` 与 `{{secrets.NAME}}`，NAME 不含 `}`：与内核的占位符写法一致。 */
const PLACEHOLDER = /\{\{(vars|secrets)\.([^}]+)\}\}/g;

/** 请求头名的合法字符，即 RFC 7230 的 token（与思源前端 aiProviderHeaders.ts 同一条规则）。 */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function valueOf(items: {name?: string; value?: string}[] | undefined, name: string): string | undefined {
    return items?.find((item) => item?.name === name)?.value;
}

/**
 * 按目标主机取密钥。
 *
 * 主机不在密钥自己的允许列表里时不返回，密钥也就不会被送到未授权的端点 ——
 * 与内核 `ResolveSecretsVarsForHost` 的约束一致（kernel/conf/secrets.go）。
 * 变量没有这层限制：它本来就不该存敏感数据。
 */
function secretForHost(config: SiyuanConfig | undefined, name: string, host: string): string | undefined {
    const found = config?.secrets?.items?.find((item) => item?.name === name);
    if (!found || host === "") {
        return undefined;
    }
    const allowed = (found.allowedHosts ?? []).some((allowedHost) => allowedHost.trim().toLowerCase() === host);
    return allowed ? found.value : undefined;
}

/** 替换占位符。查不到名字（没配、或密钥不允许这个主机）时原样保留，便于发现引用写错了。 */
function resolvePlaceholders(value: string, host: string, config: SiyuanConfig | undefined): string {
    return value.replace(PLACEHOLDER, (match, kind: string, name: string) => {
        const found = kind === "secrets"
            ? secretForHost(config, name, host)
            : valueOf(config?.variables?.items, name);
        return found === undefined ? match : found;
    });
}

/** 控制字符会让内核发请求时直接失败，而报错原文可能把密钥一起带出去，所以在发出前就拦住。 */
function hasControlChars(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        // 制表符是合法的请求头字符，其余控制字符不是
        if ((code < 32 && code !== 9) || code === 127) {
            return true;
        }
    }
    return false;
}

/**
 * 把配置里的请求头文本解析成键值对。空文本表示没有自定义请求头。
 *
 * 校验照搬思源自己的规则（app/src/config/tabs/ai/aiProviderHeaders.ts）：
 * 名字必须是合法 token、大小写不敏感地不许重复、取值必须是字符串。
 * 报错里只出现请求头名字，绝不回显取值 —— 取值可能就是别人粘进来的密钥。
 */
export function parseCustomHeaders(text: string): Record<string, string> {
    if (text.trim() === "") {
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ApiError(`Custom request headers are not valid JSON: ${detail}`, false);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ApiError('Custom request headers must be a JSON object, e.g. {"X-Route": "a"}', false);
    }

    const headers: Record<string, string> = {};
    const names = new Set<string>();
    for (const [name, value] of Object.entries(parsed)) {
        if (!HEADER_NAME.test(name)) {
            throw new ApiError(`Invalid custom request header name: ${name}`, false);
        }
        if (names.has(name.toLowerCase())) {
            throw new ApiError(`Duplicate custom request header: ${name}`, false);
        }
        if (typeof value !== "string") {
            throw new ApiError(`Custom request header ${name} must have a string value`, false);
        }
        names.add(name.toLowerCase());
        headers[name] = value;
    }
    return headers;
}

/**
 * 本次请求要带的全部请求头：协议自带的鉴权头打底，自定义头覆盖同名项。
 *
 * 覆盖而不是并存，与思源内核注入供应商请求头的行为一致
 * （kernel/util/openai_headers.go 的 `headers.Set(...)`）：
 * 一个把密钥写进 `Authorization` 的供应商，不该同时收到插件那份 Bearer。
 */
export function withCustomHeaders(base: Record<string, string>, api: ApiSettings): Record<string, string> {
    const custom = parseCustomHeaders(api.customHeaders);
    if (Object.keys(custom).length === 0) {
        return {...base};
    }

    const config = siyuanConfig();
    const host = hostOf(api.baseURL);
    const merged = {...base};
    for (const [name, raw] of Object.entries(custom)) {
        const value = resolvePlaceholders(raw, host, config);
        if (hasControlChars(value)) {
            throw new ApiError(
                `Custom request header ${name} resolves to a value with control characters. ` +
                "Check the SiYuan secret or variable it references",
                false,
            );
        }
        const existing = Object.keys(merged).find((key) => key.toLowerCase() === name.toLowerCase());
        if (existing !== undefined) {
            delete merged[existing];
        }
        merged[name] = value;
    }
    return merged;
}

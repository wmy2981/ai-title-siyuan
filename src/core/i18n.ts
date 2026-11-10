/**
 * i18n 取值与参数插值。
 *
 * 思源在插件加载时只注入当前语言的一份 i18n 表（`this.i18n`），
 * 缺失的键会得到 undefined，所以这里统一回退为键名本身，便于发现漏配。
 */

export type I18n = Record<string, string>;

export function makeT(i18n: I18n) {
    return function t(key: string, params?: Record<string, string | number>): string {
        let text = i18n[key] ?? key;
        if (params) {
            for (const [name, value] of Object.entries(params)) {
                text = text.replaceAll(`{${name}}`, String(value));
            }
        }
        return text;
    };
}

export type T = ReturnType<typeof makeT>;

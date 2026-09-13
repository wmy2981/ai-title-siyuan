/**
 * Debug logging.
 *
 * Disabled by default. When the user turns on "Debug mode" in the settings
 * panel, every outbound request, every raw model response and every pipeline
 * decision is written to the console so a misconfiguration can be diagnosed
 * without guessing. All output is in English.
 */

let enabled = false;

export function setDebug(value: boolean): void {
    enabled = value;
}

export function isDebug(): boolean {
    return enabled;
}

function stamp(): string {
    return new Date().toISOString().slice(11, 23);
}

/** Log a single pipeline step. No-op unless debug mode is on. */
export function debug(message: string, ...rest: unknown[]): void {
    if (!enabled) {
        return;
    }
    if (rest.length === 0) {
        console.log(`[ai-title ${stamp()}] ${message}`);
        return;
    }
    console.log(`[ai-title ${stamp()}] ${message}`, ...rest);
}

/** Log a failure. Errors are worth surfacing prominently once debug mode is on. */
export function debugError(message: string, error: unknown): void {
    if (!enabled) {
        return;
    }
    console.error(`[ai-title ${stamp()}] ${message}`, error);
}

function truncate(value: string, limit: number): string {
    return value.length <= limit ? value : `${value.slice(0, limit)}… (${value.length} chars total)`;
}

/** Pretty-print one message for the conversation dump. */
function formatMessage(role: string, content: string): string {
    const limit = role === "system" ? 2000 : 4000;
    return `  [${role}]\n${truncate(content, limit).split("\n").map((line) => `    ${line}`).join("\n")}`;
}

/**
 * Dump the full conversation sent to the model.
 * The request payload is logged verbatim so the reader sees the exact wire body,
 * including any thinking-suppression fields.
 */
export function debugRequest(url: string, payload: Record<string, unknown>): void {
    if (!enabled) {
        return;
    }
    const {messages, ...rest} = payload as {messages?: {role: string; content: string}[]} & Record<string, unknown>;
    const lines = [
        `POST ${url}`,
        "  -- request parameters --",
        `  ${JSON.stringify(rest, null, 2).split("\n").join("\n  ")}`,
        `  -- messages (${messages?.length ?? 0}) --`,
        ...(messages ?? []).map((message) => formatMessage(message.role, message.content)),
    ];
    console.log(`[ai-title ${stamp()}] Full conversation sent to the model:\n${lines.join("\n")}`);
}

/** Log an HTTP response summary plus the raw body. */
export function debugResponse(url: string, status: number, body: string): void {
    if (!enabled) {
        return;
    }
    console.log(
        `[ai-title ${stamp()}] Response from ${url} (HTTP ${status}):\n${truncate(body, 4000).split("\n").map((line) => `    ${line}`).join("\n")}`,
    );
}

/** Dump the final text the model produced, before any parsing. */
export function debugModelText(text: string): void {
    if (!enabled) {
        return;
    }
    console.log(`[ai-title ${stamp()}] Model text output:\n${text.split("\n").map((line) => `    ${line}`).join("\n")}`);
}

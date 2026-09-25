/**
 * Debug logging.
 *
 * Disabled by default. When the user turns on "Debug mode" in the settings
 * panel, every outbound request, every raw model response and every pipeline
 * decision is written to the console so a misconfiguration can be diagnosed
 * without guessing.
 *
 * Nothing here is truncated: a cut-off payload hides exactly the field that
 * caused the problem, and the reader cannot tell whether the log ended because
 * the value did. The cost is only paid when the switch is on.
 *
 * The API key is never logged: it travels in a header, not in the request body,
 * and the settings snapshot printed at the start of a run is redacted.
 * All output is in English.
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

/** Indent a multi-line block so it reads as one entry under its own heading. */
function indent(text: string): string {
    return text.split("\n").map((line) => `    ${line}`).join("\n");
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

/**
 * Dump a value as JSON, in full.
 *
 * Used for the settings a run actually used and for the per-note decisions the
 * pipeline made, so a report can be reconstructed from the console alone.
 */
export function debugJson(label: string, value: unknown): void {
    if (!enabled) {
        return;
    }
    const text = JSON.stringify(value, null, 2) ?? String(value);
    console.log(`[ai-title ${stamp()}] ${label}:\n${indent(text)}`);
}

/**
 * Dump the full conversation sent to the model: the exact request body first,
 * then a decoded view of the messages, which is easier to read than the JSON
 * escaping of a long prompt.
 */
export function debugRequest(url: string, payload: Record<string, unknown>): void {
    if (!enabled) {
        return;
    }
    const messages = (payload as {messages?: {role: string; content: string}[]}).messages ?? [];
    const lines = [
        `POST ${url}`,
        "  -- request body (verbatim) --",
        indent(JSON.stringify(payload, null, 2)),
        `  -- decoded messages (${messages.length}) --`,
        ...messages.map((message) => `  [${message.role}]\n${indent(message.content)}`),
    ];
    console.log(`[ai-title ${stamp()}] Full conversation sent to the model:\n${lines.join("\n")}`);
}

/** Log an HTTP response summary plus the complete raw body. */
export function debugResponse(url: string, status: number, body: string): void {
    if (!enabled) {
        return;
    }
    console.log(
        `[ai-title ${stamp()}] Response from ${url} (HTTP ${status}, ${body.length} chars):\n${indent(body)}`,
    );
}

/** Dump the final text the model produced, before any parsing. */
export function debugModelText(text: string): void {
    if (!enabled) {
        return;
    }
    console.log(`[ai-title ${stamp()}] Model text output (${text.length} chars):\n${indent(text)}`);
}

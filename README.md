<div align="right">

[简体中文](README.zh-CN.md) · **English**

</div>

# AI Title

A SiYuan plugin that names your notes for you. Select one or more notes, and it asks an OpenAI-compatible chat completions endpoint for a title for each one — then either writes them back or lets you review first.

## Why it exists

SiYuan names a new document `Untitled`. Renaming later is a manual chore, and doing it for a folder full of notes is tedious enough that most people never get around to it.

This plugin does the naming pass for you. It reads each note's content, asks a model for a title, and writes it back through the kernel's own rename path so the document path, its child documents' paths and the search index all stay consistent.

## Features

- **Generate in bulk.** Select many notes in the document tree and title them in one action. Notes are split into batches and the batches run concurrently.
- **Review before writing.** Every title stays editable. Untick what you don't want, edit any field, or regenerate a single row.
- **Your prompts, your style.** Rewrite both the system and user prompt. `{{content}}`, `{{language}}` and `{{style}}` are filled in per request.
- **Any compatible endpoint.** Point it at any OpenAI-compatible chat completions API, or import a provider you already configured in SiYuan.
- **Turn reasoning off.** Built-in request body presets for Qwen, vLLM, Doubao and others, plus a free-form JSON option.
- **Built for debugging.** Debug mode dumps the full request and response to the console.

## Requirements

- SiYuan 3.8.3 or later.
- An OpenAI-compatible chat completions endpoint, and its base URL and API key.

## Install

1. Search for `ai-title-siyuan` in the SiYuan marketplace and install it from there.
2. Or download `package.zip` from the [latest release](https://github.com/wmy2981/ai-title-siyuan/releases/latest), then in SiYuan open **Settings → Marketplace → Downloaded**, click **Install from package**, and pick that zip. Enable the plugin afterwards.

To build it yourself:

```bash
git clone https://github.com/wmy2981/ai-title-siyuan.git
cd ai-title-siyuan
npm ci
npm run build
```

That writes `package.zip` in the repository root.

## Setup

Open **Settings → Marketplace → Downloaded → AI Title → Settings**.

1. **Base URL** — include the version segment your provider documents.
2. **API Key** — sent as `Authorization: Bearer <key>`. Leave empty if your endpoint needs no key.
3. **Model** — type a name, click **Fetch models** to pick from the provider's list, or use **Import from SiYuan** to copy a provider you already configured there.
4. Click **Test connection**. Any reply means the configuration works.

### Settings reference

| Group | Setting | Default | Notes |
| --- | --- | --- | --- |
| API | Protocol | Chat Completions API | Only this protocol is implemented. |
| API | Temperature | `1.0` | `0`–`2`. Lower is more deterministic. |
| API | Top P | `0.8` | Leave empty to omit from the request. |
| API | Top K | *empty* | Omitted when empty. The official OpenAI API rejects unknown body parameters with a 400, so only fill this in for providers that accept it. |
| API | Max output tokens | `512` | Sent as `max_completion_tokens`, falling back to `max_tokens` if the provider rejects that name. |
| Behaviour | Timeout | `10000` ms | Per request. Batches are concurrent, so this is not a shared budget. |
| Behaviour | Retries | `1` | Only for rate limits, server errors, timeouts and network failures. |
| Behaviour | Note content limit | `1000` characters | Each note is truncated on its own, keeping the beginning. |
| Behaviour | Notes per request | `3` | Selecting more splits the work into batches. |
| Behaviour | Max concurrent requests | `3` | Lower it if your provider rate limits. |
| Behaviour | Apply titles automatically | Disabled | See below. |
| Interface | Toolbar button | On | |
| Interface | Breadcrumb button | Off | |
| Interface | Document tree menu | On | |
| Interface | Debug mode | Off | Logs the full conversation JSON to the console. |

### Applying titles

| Mode | Single note | Several notes |
| --- | --- | --- |
| **Disabled** (default) | Confirmation dialog | Confirmation dialog |
| **Single note only** | Written directly | Confirmation dialog |
| **Always** | Written directly | Written directly |

Selecting more than one note **always** opens the confirmation dialog, whichever mode is set. Bulk-renaming documents is destructive and SiYuan's rename has no undo stack.

### Disabling reasoning

Reasoning models can be slow, and some leave `content` empty while putting everything in a reasoning field. The **Disable thinking** switch adds `reasoning_effort: "none"` to the request body.

That field is the one written into the protocol rather than invented by a vendor: `reasoning_effort` is an OpenAI Chat Completions parameter, and DeepSeek, Ollama, Gemini 2.5, GLM, qwen3.8-max and OpenRouter all read `none` as "do not reason".

It is not universal, and two cases cannot be turned off at all:

- Models that always reason have no off setting (Gemini 2.5 Pro, Gemini 3, thinking-only Qwen models).
- Strict endpoints reject unknown parameters with a 400 — OpenAI's own API does, and GPT-6 Astra refuses even `none`.

You are told in both cases. When the switch is on and the model reasoned anyway — the response carried `reasoning_content`, or `usage` reported reasoning tokens — the run ends with a "disable thinking had no effect" notice.

That notice matters because this failure is otherwise **silent**: the request succeeds, and you keep paying tokens and latency for a reasoning trace you never asked for.

## Usage

Four entry points, all doing the same thing:

- The **toolbar button** names the note you are currently editing.
- The **breadcrumb button** in the editor does the same.
- **Right-click notes in the document tree** to name one or many. This is the bulk path.
- The **command palette** has *Generate title with AI*.

## Notes and limits

- **Content is read with `/api/export/exportMdContent`**, not from the editor buffer. Exporting produces clean Markdown without the block attribute lines that the kramdown API appends.
- **A note with no content is skipped** rather than sent, so the model cannot invent a title for an empty document.
- **A note the model does not return a title for is reported as a failure.** The plugin never guesses a mapping or falls back to a positional match, because that would write a title onto an unrelated note.
- **`reasoning_content` is read as a fallback** when `content` comes back empty, since some models put the entire answer there.
- **The publish service is not supported.** Publish visitors carry a read-only role, and the kernel endpoint the plugin uses requires an administrator role. `disabledInPublish` is set accordingly.

## Troubleshooting

Enable **Debug mode** in the settings and open the console. It prints the full request body, the raw response and each pipeline decision.

| Symptom | Likely cause |
| --- | --- |
| `HTTP 404` | Wrong base URL. Check the version segment against your provider's documentation. |
| `HTTP 401` | Wrong or missing API key. |
| `max_completion_tokens` in an error | Your provider only accepts `max_tokens`. The plugin retries with the right name automatically; seeing this twice means the retry also failed. |
| `HTTP 400` mentioning an unknown parameter | Your provider rejects `reasoning_effort`. Turn off **Disable thinking**. |
| The model returns nothing | Reasoning may have consumed the whole output budget. Raise **Max output tokens** or disable thinking. |
| Titles not in the language you want | Change **Title language**. It defaults to your SiYuan interface language. |

## Development

```bash
npm run dev        # rebuild on change
npm run build      # production build + package.zip
npm run typecheck  # tsc --noEmit
npm run icon       # regenerate assets/icon.png and compress assets/preview.png
```

## License

MIT — see [LICENSE](LICENSE).

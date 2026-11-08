/**
 * 空白笔记粘贴内容后自动生成标题（#47）。
 *
 * 两件事在这里：判断「粘贴前是不是一篇空白笔记」，以及等粘贴的内容真正落到编辑器里。
 * 粘贴事件是**插入之前**发出的（protyle 收到剪贴板内容、随后才往正文里写），
 * 所以两件事都必须在粘贴当时的 DOM 上做：先看它空不空，再看它什么时候变得不空。
 *
 * 「空白」指的是新建文档那种空 —— 只有空段落、空标题。正文块里有文字算有内容，
 * 只有一张图、一段嵌入音视频或 iframe 同样算有内容：那种笔记已经是有东西的笔记，
 * 给它改名不在本功能的范围内。
 */

/** 只有这两类块里的文字算正文：它们空了，文档才算空白。 */
const TEXT_BLOCK_TYPES = new Set(["NodeParagraph", "NodeHeading"]);

/** 行内占位符与属性面板（.protyle-attr）里的零宽空格不算文字。 */
const INVISIBLE = /[\u200b\u200c\u200d\ufeff]/g;

/**
 * 正文块里的内嵌内容。
 *
 * 图片在思源里可以是行内的 `<img>`，音视频与 iframe 也会以 HTML 标签留在正文中；
 * 这类块里一个字都没有，但它显然不是「空笔记」。
 */
const INLINE_MEDIA = "img, video, audio, iframe, object, embed";

/**
 * 内容稳定的等待时间。
 *
 * 一次粘贴往往连插好几个块，DOM 会连续变动若干次；用户接着粘贴下一段时同样会重来，
 * 因此一段连续操作只在最后生成一次标题。
 */
const SETTLE_MS = 1200;

/**
 * 盯住的期限。粘贴其实没落地（被拦截、剪贴板为空、块被撤销）时不必一直等下去。
 * 超时后监视自己结束，不生成标题 —— 这比「把之后的输入当成粘贴」安全。
 */
const WATCH_TIMEOUT_MS = 20000;

function blockText(block: Element): string {
    return (block.textContent ?? "").replace(INVISIBLE, "").trim();
}

/** 一个正文块是不是空的：没有文字，也没有图片、音视频这类内嵌内容。 */
function isBlankBlock(block: Element): boolean {
    return TEXT_BLOCK_TYPES.has(block.getAttribute("data-type") ?? "") &&
        blockText(block) === "" &&
        block.querySelector(INLINE_MEDIA) === null;
}

/**
 * 编辑器里是不是一篇空白笔记。
 *
 * 只看正文：图片、表格、代码块、嵌入块这些非正文块，即使没有文字也一律算有内容。
 */
export function isBlankEditor(editor: Element): boolean {
    return Array.from(editor.children).every(isBlankBlock);
}

/**
 * 盯住一次粘贴，等内容落地再回调。
 *
 * 回调只会发生一次，参数说明有没有等到内容：`true` 表示编辑器里已经有不空白的正文，
 * `false` 表示监视结束（超时、编辑器已销毁，或被返回的函数取消）。
 * 返回值用来取消，插件卸载时调用。
 */
export function watchPastedNote(editor: Element, onDone: (content: boolean) => void): () => void {
    let settleTimer: number | undefined;
    let settled = false;

    const observer = new MutationObserver(() => {
        if (!editor.isConnected) {
            finish(false);
            return;
        }
        if (settleTimer !== undefined) {
            window.clearTimeout(settleTimer);
        }
        settleTimer = window.setTimeout(check, SETTLE_MS);
    });

    const deadline = window.setTimeout(() => finish(false), WATCH_TIMEOUT_MS);

    function finish(content: boolean): void {
        if (settled) {
            return;
        }
        settled = true;
        observer.disconnect();
        if (settleTimer !== undefined) {
            window.clearTimeout(settleTimer);
        }
        window.clearTimeout(deadline);
        onDone(content);
    }

    function check(): void {
        settleTimer = undefined;
        if (settled) {
            return;
        }
        // 还是空白：内容没落地或被撤销了，继续等下一次变动，直到期限
        if (isBlankEditor(editor)) {
            return;
        }
        finish(true);
    }

    observer.observe(editor, {childList: true, subtree: true, characterData: true});
    return () => finish(false);
}

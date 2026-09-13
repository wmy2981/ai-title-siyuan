/**
 * 把生成的标题写回笔记。
 *
 * 用 /api/filetree/renameDocByID 而不是直接写块属性：
 * 前者会同步更新 .sy 路径、HPath、子文档 HPath、索引与引用锚文本，
 * 直接改 IAL 的 title 会让文件树与索引不同步。
 *
 * 注意思源的重命名没有撤销栈（内核 RenameDoc 不提供 undo），
 * 所以调用方必须在写入前把不可撤销这一点明确告诉用户。
 */
import {fetchSyncPost} from "siyuan";

export interface TitleEdit {
    id: string;
    title: string;
}

export interface ApplyOutcome {
    applied: TitleEdit[];
    /** 写入失败的条目及原因。 */
    failed: {edit: TitleEdit; message: string}[];
}

/**
 * 逐条应用标题，单条失败不中断后续。
 * 标题超长、笔记本被锁定、文档已被删除等都会在这里体现为单条失败。
 */
export async function applyTitles(edits: TitleEdit[]): Promise<ApplyOutcome> {
    const applied: TitleEdit[] = [];
    const failed: {edit: TitleEdit; message: string}[] = [];

    for (const edit of edits) {
        try {
            const response = await fetchSyncPost("/api/filetree/renameDocByID", {
                id: edit.id,
                title: edit.title,
            });
            if (response.code !== 0) {
                failed.push({edit, message: response.msg || `code ${response.code}`});
            } else {
                applied.push(edit);
            }
        } catch (error) {
            failed.push({edit, message: error instanceof Error ? error.message : String(error)});
        }
    }

    return {applied, failed};
}

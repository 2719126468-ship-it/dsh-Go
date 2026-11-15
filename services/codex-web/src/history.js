/**
 * 把 app-server 的历史记录（thread/turns/list 返回的 Turn[]）翻译成前端好渲染的
 * 消息序列。复用 appserver.js 里那套 item → 工具卡片的映射，保证"历史里的卡片"
 * 和"刚跑出来的卡片"长得一模一样。
 *
 * 输出形状：
 *   [
 *     { role: "user", text },
 *     { role: "assistant", parts: [ {type:"text",text} | {type:"tool",id,name,input,output,status} ] },
 *     ...
 *   ]
 */
import { isToolItem, toolInput, toolOutput, toolLabel } from "./appserver.js";

/** 一条 item 是不是"给人看的"（reasoning / hookPrompt 之类不进历史）。 */
function isRenderableItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "plan") return true;
  if (item.type === "reasoning") return true;
  return isToolItem(item);
}

export function turnsToMessages(turns) {
  const messages = [];

  for (const turn of Array.isArray(turns) ? turns : []) {
    const parts = [];

    for (const item of turn?.items || []) {
      if (!isRenderableItem(item)) continue;

      if (item.type === "userMessage") {
        const text = (item.content || []).map((c) => c?.text || "").join("").trim();
        // 先把上一轮助手内容收尾，再放用户消息
        if (parts.length) { messages.push({ role: "assistant", parts: parts.slice() }); parts.length = 0; }
        if (text) messages.push({ role: "user", text });
        continue;
      }

      if (item.type === "agentMessage") {
        if (item.text) parts.push({ type: "text", text: item.text });
        continue;
      }

      if (item.type === "plan") {
        if (item.text) parts.push({ type: "plan", text: item.text });
        continue;
      }

      // 推理摘要：历史里也回填，跟刚跑出来的"Thinking"块长得一样。
      if (item.type === "reasoning") {
        const summary = Array.isArray(item.summary) ? item.summary.join("\n\n").trim() : "";
        if (summary) parts.push({ type: "reasoning", id: item.id, text: summary });
        continue;
      }

      if (isToolItem(item)) {
        const { id, name, input } = toolInput(item);
        parts.push({
          type: "tool",
          id,
          name,
          input,
          label: toolLabel(item),
          output: toolOutput(item),
          status: item.status,
          durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
        });
      }
    }

    if (parts.length) messages.push({ role: "assistant", parts });
  }

  return messages;
}

/**
 * thread/list 返回的 Thread → 会话列表里的一条。
 * name 基本都是 null，标题就用 preview（Codex 存的第一句用户输入）。
 */
export function summarizeThread(thread) {
  const title = (thread?.name || thread?.preview || "").trim() || "(无标题会话)";
  return {
    id: thread?.id,
    title: title.length > 120 ? title.slice(0, 120) + "…" : title,
    createdAt: thread?.createdAt ?? null,
    updatedAt: thread?.updatedAt ?? null,
    cwd: thread?.cwd ?? null,
    model: thread?.model ?? null,
  };
}

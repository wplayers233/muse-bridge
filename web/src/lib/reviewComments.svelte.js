// 审阅面板的行内评论：行锚定的反馈收集（P0）。
//
// 审阅面板（ReviewPanel，三家共用）与聊天输入框（CliChat）不在同一个组件里，
// 评论要跨组件流动：面板里写 → 下一条聊天消息带上 → 注入给模型。
// 存这里（按工作空间 ws 分桶）：
//   · 面板写评论时只知道 ws（dockState.ws），不知道 agent；
//   · 聊天发送时只知道 agent 的当前工作目录（cwdOf），用它当 key 取。
// 两边 key 都是工作空间绝对路径，同一工作空间的面板与对话自然对上；
// 换了工作空间就取不到，不会把 A 仓库的评论带进 B 仓库的对话。
//
// 评论只活在内存里（刷新页面丢掉）：它是对「当前这份 diff」的反馈，diff 一变
// 行号就可能对不上；持久化反而会把过期锚点带进新对话。发送时一次性取走清空。

// 每条：{ id, file, side: 'new'|'old', no, lineText, text, at }
export const reviewComments = $state({ byWs: {} });

const key = (ws) => String(ws || '');

export function addReviewComment(ws, c) {
  const k = key(ws);
  if (!k) return null;
  const item = {
    id: 'rc' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
    file: String(c.file || ''),
    side: c.side === 'old' ? 'old' : 'new',
    no: Number(c.no) || 0,
    lineText: String(c.lineText || ''),
    text: String(c.text || '').trim(),
    at: Date.now(),
  };
  if (!item.text) return null;
  const list = reviewComments.byWs[k] || [];
  reviewComments.byWs[k] = [...list, item];
  return item;
}

export function dropReviewComment(ws, id) {
  const k = key(ws);
  const list = reviewComments.byWs[k] || [];
  reviewComments.byWs[k] = list.filter((c) => c.id !== id);
}

export function dropAllReviewComments(ws) {
  const k = key(ws);
  if (k) reviewComments.byWs[k] = [];
}

export const reviewCommentCount = (ws) => (reviewComments.byWs[key(ws)] || []).length;

export const reviewCommentsFor = (ws) => [...(reviewComments.byWs[key(ws)] || [])];

// 发送时取走（取完清空）：评论只跟一条消息走，不重复带。
export function takeReviewComments(ws) {
  const list = reviewCommentsFor(ws);
  dropAllReviewComments(ws);
  return list;
}

import { t } from './i18n.js';

// 发消息时把评论拼成给模型的指令块（行锚定：文件 + 行号 + 该行内容 + 反馈）。
export function formatReviewComments(list) {
  if (!list.length) return '';
  const lines = list.map((c) => {
    const anchor = c.no ? `${c.file}:${c.no}` : c.file;
    const shown = c.lineText ? ` ${c.lineText}` : '';
    return `- ${anchor}${shown}\n  ${c.text}`;
  });
  return `${t('行内审阅评论（来自审阅面板，请处理，保持改动范围最小）：')}\n${lines.join('\n')}`;
}

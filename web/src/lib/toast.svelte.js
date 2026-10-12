// 轻量 toast（即时反馈，3 秒自隐）的统一入口。状态只有一份，由 App 根挂的 <Toast /> 渲染。
// 错误提示紧跟在一次服务端出错（5xx / 连不上）之后弹出时，带一个「报告」按钮、多停几秒：
// 用户嫌麻烦不报，多半是因为不知道去哪报——就在出错的地方给入口。
import { recentFault, openReport } from './feedback.svelte.js';

export const toast = $state({ text: '', kind: 'ok', action: null });
let _timer = null;
// action：{ label, fn } —— 调用方自带按钮文案（换版提示的「刷新」）。不传就按下面这套：
// 出错（5xx / 连不上）时给「报告问题」。
export function showToast(text, kind = 'ok', action = null, ms = 0) {
  toast.text = String(text || ''); toast.kind = kind;
  const fault = kind === 'err' ? recentFault() : null;
  // 文字当场记下：点按钮时 toast 先收起（text 清空），再开报告框
  const msg = toast.text;
  toast.action = action || (fault ? { fn: () => openReport({ error: msg, kind: 'bug' }) } : null);
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => { toast.text = ''; toast.action = null; }, ms || (fault ? 7000 : 3000));
}
export function hideToast() { if (_timer) clearTimeout(_timer); toast.text = ''; toast.action = null; }

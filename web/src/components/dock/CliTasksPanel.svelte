<script>
  // CLI 分页（Codex / ZCode）工作台的「任务」卡：本会话的待办清单。
  //
  // 数据源与 Claude 页 TasksPanel 的「单写者规则」同一思路：只读 chat.items 里已有的数据，
  // 不另立第二份任务表。cliChat.svelte.js 在归一事件流里已经把 { type:'todo', items } 存进了
  // 每条 agent 消息的 todos 字段（后端来自 codex 的 todo_list item，见 agent-cli.mjs:261）；
  // 这里取【最近一条非空 todos】渲染——todo 清单是整表快照，最新的一条就是当前状态。
  //
  // ZCode 的 stream-json 事件表没有 todo 类事件（官方 headless 契约未提供，见
  // agent-cli.mjs parseZcodeEvent 的注释），这一页会显示空态说明，不是 bug。
  import { cliChat } from '../../lib/cliChat.svelte.js';
  import { t } from '../../lib/i18n.js';

  let { agent } = $props();

  const chat = $derived(cliChat[agent]);

  // 最近一条非空 todos（从后往前扫；清单是快照语义，最新即当前）。
  const todos = $derived.by(() => {
    for (let i = chat.items.length - 1; i >= 0; i--) {
      const m = chat.items[i];
      if (m && Array.isArray(m.todos) && m.todos.length) return m.todos;
    }
    return [];
  });

  // 条目状态 → 展示态。codex 的 status 取值照官方 TodoWrite 惯例：
  // completed（完成）/ in_progress（进行中）/ pending（待办）；认不出的按待办处理。
  const view = $derived(todos.map((x, i) => ({
    ...x,
    key: i,
    done: x.status === 'completed',
    doing: x.status === 'in_progress' || x.status === 'doing',
  })));
  const doneCount = $derived(view.filter((x) => x.done).length);
</script>

<div class="ctp">
  {#if !view.length}
    <div class="ctp-empty">{t('这一轮还没有任务清单')}</div>
  {:else}
    <div class="ctp-sum">{t('{done}/{n} 完成', { done: doneCount, n: view.length })}</div>
    <ul class="ctp-list">
      {#each view as x (x.key)}
        <li class="ctp-item" class:doing={x.doing} class:done={x.done}>
          <span class="ctp-mark" aria-hidden="true">
            {#if x.done}
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>
            {:else if x.doing}
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="5.5" opacity=".35"/><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"/></svg>
            {:else}
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="5.5" opacity=".4"/></svg>
            {/if}
          </span>
          <span class="ctp-text">{x.text}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .ctp { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 10px; }
  .ctp-empty { font-size: 12.5px; opacity: .55; padding: 6px 0; }
  .ctp-sum { font-size: 11.5px; opacity: .55; margin-bottom: 6px; }
  .ctp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .ctp-item { display: flex; align-items: flex-start; gap: 8px; padding: 5px 6px; border-radius: 8px; font-size: 13px; line-height: 1.5; }
  .ctp-item:active { background: color-mix(in srgb, currentColor 7%, transparent); }
  .ctp-mark { flex: none; width: 16px; height: 16px; margin-top: 2px; display: inline-flex; }
  .ctp-mark svg { width: 16px; height: 16px; }
  .ctp-text { min-width: 0; word-break: break-word; }
  .ctp-item.doing .ctp-text { font-weight: 500; }
  .ctp-item.done .ctp-text { opacity: .5; text-decoration: line-through; }
</style>

// 英文界面文案 · codex-zcode：外部 CLI agent 分页（Codex / ZCode 的页头、侧面板、会话流、接入卡）
// 与设置「Agent」页里这两家的状态说明（键 = 中文原文，见 lib/i18n.js）。
// 术语照 i18n/GLOSSARY.md §3：Codex 走 OpenAI（Codex app）口吻；ZCode 走 Z.ai 自家口吻；
// 会话 = Session；句首大写、无感叹号、无请求式 please。
export default {
  // —— 分页页头 / 页脚（两家共用）——
  '返回主页': 'Back to Home',
  '切换明暗主题': 'Toggle light/dark theme',
  '关闭': 'Close',
  '收起侧栏': 'Collapse sidebar',
  '菜单': 'Menu',
  '关闭侧栏': 'Close sidebar',
  '主页': 'Home',
  '新会话': 'New session',
  '接入设置': 'Setup',
  '会话': 'Session',
  '工作目录': 'Workspace',
  '还没有会话': 'No sessions yet',
  '删除': 'Delete',
  '你好': 'Hey there',
  '你好，{name}': 'Hey there, {name}',
  '正在读取状态…': 'Reading status…',
  '没装命令行工具': 'CLI not installed',
  '装好了，还没登录': 'Installed, not signed in',
  '已接上': 'Connected',
  '还没开始': 'Not started yet',
  '更换工作目录': 'Change workspace',
  '选择工作目录': 'Choose workspace',
  '把文件夹拖进底栏，它就是 ZCode 的工作目录': 'Drag a folder into the bar below to make it the ZCode workspace',
  '把文件夹拖进底栏，它就是 Codex 的工作目录': 'Drag a folder into the bar below to make it the Codex workspace',
  '工作目录已换成 {dir}': 'Workspace changed to {dir}',
  '换不了这个目录': 'Cannot use that folder',
  '登录失效或套餐没生效：在服务器上重新跑一次 {cmd}，再回这里点「重新检测」':
    'The sign-in expired or the plan is not active: run {cmd} again on the server, then tap “Check again” here',

  // —— Codex 分页（照官方 TUI 的页头盒子：模型 / 目录）——
  '模型': 'Model',
  '思考深度': 'Reasoning effort',
  '默认': 'Default',
  '换不了这个模型': 'Cannot switch to that model',
  '换不了这个思考深度': 'Cannot use that reasoning effort',
  // 工作台的「工作台 / 审阅 / 终端 / 文件 / 关闭工作台 / 工作空间加载中…」等键在
  // i18n/en/dock-codex-agy.js 里已有（Claude 工作台与 Codex 侧边工作区共用那一份词典），
  // 这里只放它没有的两条：整组按钮的提示语，和门禁挡下时的说明。
  '审阅 / 终端 / 文件': 'Review / Terminal / Files',
  '这个分页现在用不了它': 'That panel is not available on this page',
  '目录': 'Directory',
  '用 codex 自己的配置（codex /model 里改）': 'Uses Codex’s own configuration (change it with codex /model)',
  '用 codex 自己的配置': 'Uses Codex’s own configuration',
  '让 Codex 做点什么？': 'What should Codex do?',
  '这个分页直接跑这台机器上的 codex，用的是它自己的模型配置。':
    'This page runs the codex CLI on this machine, using Codex’s own model configuration.',

  // —— ZCode 分页（官方 Zai Dark / Zai Light 配色，对话帧 + 侧面板）——
  '问 ZCode 做点什么？': 'What should ZCode do?',
  '接入': 'Set up',
  '这个分页直接跑这台机器上的 zcode：装了、登录过就能用，用的是它自己的模型配置。':
    'This page runs the zcode CLI on this machine: install it and sign in once, and it uses ZCode’s own model configuration.',
  '还没开始': 'Not started yet',
  '新会话': 'New session',
  '开一段新会话': 'Start a new session',
  '正在读取状态…': 'Reading status…',
  '没装命令行工具': 'CLI not installed',
  '装好了，还没登录': 'Installed, not signed in',
  '已接上': 'Connected',
  '重新检测': 'Check again',
  '官方文档': 'Documentation',
  '这个分页直接跑这台机器上的 zcode：装了、登录过就能用，用的是它自己的模型配置（GLM 系）。':
    'This page runs the zcode CLI on this server: install it and sign in once, and it works with its own model configuration (the GLM family).',

  // —— 会话流（Codex / ZCode 共用一套渲染）——
  '这一轮还没有任务清单': 'No task list for this turn yet',
  '{done}/{n} 完成': '{done}/{n} done',
  '还没装命令行工具 · 点这里安装': 'CLI not installed · tap to install',
  '最多附 {n} 张图片': 'Up to {n} images',
  '图片太大（单张限 {n}MB）': 'Image too large (max {n}MB each)',
  '附图片': 'Attach image',
  '移除': 'Remove',
  '停止这一轮': 'Stop this turn',
  '显示这些命令': 'Show these commands',
  '命令：/new 新会话 · /stop 停止 · @ 引用文件': 'Commands: /new new session · /stop stop · @ mention a file',
  '把 {name} 接到这台机器上': 'Connect {name} to this server',
  '这台机器上还没装它的命令行工具。装好、登录一次，这个分页就能直接对话。':
    'Its command-line tool isn’t installed on this server yet. Install it, sign in once, and you can chat here.',
  '命令行工具已经装好了，但还没登录。登录一次就能开始。':
    'The command-line tool is installed but not signed in yet. Sign in once to start.',
  '点这里直接装': 'Install on this server',
  '也可以在「设置 → Agent」里给它填一把 API key（服务器上加密保存，只回显尾 4 位），不用上机登录。':
    'You can also save an API key under Settings → Agent (kept encrypted on the server; only the last 4 characters are shown) instead of signing in on the machine.',
  '在这个工作目录里直接开聊：它会读文件、跑命令，把改动写回磁盘。':
    'Chat right here in this working directory: it reads files, runs commands, and writes changes back to disk.',
  '安装': 'Install',
  '登录': 'Sign in',
  '复制': 'Copy',
  '已复制': 'Copied',
  '发送': 'Send',
  '停止': 'Stop',
  '思考': 'Thinking',
  '工具': 'Tool',
  '正在工作…': 'Working…',

  // —— 会话流里的工具细节 / 待办 / 用量（这些数据以前解析出来又被丢掉）——
  '搜索': 'Search',
  '改动': 'Changes',
  '改': 'Edit',
  '输出': 'Output',
  '入参': 'Input',
  '退出码 {n}': 'Exit code {n}',
  '输入 {n}': 'In {n}',
  '输出 {n}': 'Out {n}',
  '共 {n}': '{n} total',

  // —— 审批卡（上游要授权才能跑某条命令 / 改某个文件）——
  '需要你授权': 'Approval needed',
  '已处理': 'Handled',
  '允许': 'Allow',
  '本会话都允许': 'Allow for this session',
  '总是允许这类命令': 'Always allow commands like this',
  '拒绝': 'Decline',
  '拒绝并停下': 'Decline and stop',
  '这一轮已经结束了，这张卡作废': 'This turn has ended, so this request is no longer valid',

  // —— 设置「Agent」页：这两家的状态说明与「去配置」面板 ——
  '这台机器上还没装': 'Not installed on this server',
  '在服务器上跑一次 codex login（ChatGPT 账号或 API key），或在环境里配 OPENAI_API_KEY。':
    'Run codex login on the server (ChatGPT account or API key), or set OPENAI_API_KEY in the environment.',
    '没装：官方安装 curl -fsSL https://chatgpt.com/codex/install.sh | sh':
    'Not installed. Official install: curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    // —— 设置「Agent」页的「去配置」面板（SecAgentKey：填 key / 一步安装）——
  'OpenAI API key': 'OpenAI API key',
  'API key': 'API key',
  '还没配': 'Not set',
  '还没登录': 'Not signed in',
  '已登录': 'Signed in',
  '登录': 'Sign in',
  '在服务器上跑一次这条命令完成登录（浏览器里点一下）。':
    'Run this once on the server to sign in (one click in the browser).',
  '没装：bash scripts/server/install-zcode.sh（官方 Linux 只能照仓库自己构建）':
    'Not installed. Run bash scripts/server/install-zcode.sh (on Linux the official path is building it from the repository).',
  '登录走浏览器授权，不认 API key（填了也不生效）。':
    'Signing in goes through browser authorization; an API key has no effect here.',
  '智谱国内版：zcode login bigmodel；Z.ai 国际版：zcode login zai。':
    'BigModel (mainland China): zcode login bigmodel; Z.ai (international): zcode login zai.',
  '点「去配置」按上面的命令在服务器上登录一次智谱 / Z.ai 账号（Coding Plan 走的就是这份登录态）。它不认 API key，登录只能走浏览器授权。':
    'Choose Set up and run the command shown to sign in with your BigModel / Z.ai account on the server; a Coding Plan works through that sign-in. An API key has no effect here: signing in is browser authorization only.',
  '在服务器上跑一次这条命令完成授权（浏览器打开它给的链接，登录你的智谱 / Z.ai 账号）。登录态存在服务器上。':
    'Run this once on the server to authorize: open the link it prints in a browser and sign in with your BigModel / Z.ai account. The sign-in is kept on the server.',
  '两个版本各一条：智谱国内版 zcode login bigmodel，Z.ai 国际版 zcode login zai；不认 API key。':
    'One command per edition: zcode login bigmodel for BigModel, zcode login zai for Z.ai. API keys are not accepted.',
  '登录会在服务器上留下凭据，之后这个分页就一直能用；不想上机的话，去「设置 → Agent → 去配置」也能看到这条命令。':
    'Signing in leaves a credential on the server and this page keeps working afterwards. If you would rather not touch the machine, Settings → Agent → Set up shows the same command.',
  '（环境变量）': ' (environment variable)',
  '粘贴 {env}': 'Paste {env}',
  '粘贴 API key': 'Paste API key',
  '保存': 'Save',
  '保存中…': 'Saving…',
  '清除': 'Clear',
  '清除中…': 'Clearing…',
  '已保存': 'Saved',
  '已清除': 'Cleared',
  '存在服务器的加密凭据里（只回显尾 4 位），跑 CLI 时注进 {env}；环境变量里已有的那把不用填。':
    'Stored in the server’s encrypted credential file (only the last 4 characters are shown) and injected into {env} when the CLI runs. If the environment variable already has one, there’s nothing to fill in here.',
  '这台机器上还没装它：分页里的「接入」卡有安装命令；装好点一次「重新检测」。':
    'It isn’t installed on this server yet. Its page’s setup card has the install command; run it, then check again.',
  '在这台机器上装': 'Install on this server',
  '安装中…': 'Installing…',
  '脚本跑完了，但还是没找到命令': 'The installer finished, but the command still isn’t there',
  '装好了': 'Installed',

  // —— 设置「Agent」页：认证提示与「还没配认证」那一段 ——
  '点「去配置」填一把 OpenAI API key（也可以在服务器上跑一次 codex login），或配 OPENAI_API_KEY。':
    'Choose Set up to save an OpenAI API key (or run codex login on the server), or set OPENAI_API_KEY.',
    '在下面填一把 OpenAI API key（或先在这台机器上跑一次 codex login），也可以配 OPENAI_API_KEY。':
    'Save an OpenAI API key below (or run codex login on this server first). OPENAI_API_KEY in the environment works too.',
    '还没配认证（填一把 key 或先登录 CLI）': 'Not signed in yet (save a key, or sign in with the CLI)',
  '这台机器上没找到 codex（bridge 自带一份：装依赖时 npm install 会装上 @openai/codex；也可以单独装，官方安装：curl -fsSL https://chatgpt.com/codex/install.sh | sh）':
    'No codex on this server. Muse Bridge ships one (npm install pulls in @openai/codex); you can also install it separately with the official installer: curl -fsSL https://chatgpt.com/codex/install.sh | sh',

  // —— 侧栏「凭据」折叠组（CodexPage 抽屉/常驻列）——
  '凭据': 'Credentials',

  // —— CliKeyForm（分页里自己填 API key）——
  '已清除，回落到环境变量或 CLI 登录态': 'Cleared — falling back to the environment variable or the CLI’s own sign-in',
  '已保存（只显示尾 4 位）': 'Saved (only the last 4 characters are shown)',
  '没存上': 'Couldn’t save',
  '已存 · 尾 {tail}': 'Saved · ends in {tail}',
  '没存': 'Not saved',
  '换一把（留空不动）': 'Replace it (leave empty to keep)',
  '粘贴你的 API Key': 'Paste your API key',

  // —— 账户菜单里的 coding plan 余额行（UserMenu，按所在页显示对应那家）——
  '余额 {b}': 'Balance {b}',

  // —— 输入框照官方 PC 端：+ 弹层菜单 / 模型一体浮层（CliAddMenu / CliModelPicker）——
  '添加图片': 'Add image',
  '添加文件': 'Add files',
  '添加附件': 'Add attachments',
  '选择模型': 'Select model',
  '‹ 返回': '‹ Back',
  // 思考深度档位（effort 滑杆上的中文名；GLOSSARY §630：effort 选择器不复用
  // 游戏画质档的 t('极高')/t('最高')，所以 xhigh=超高、ultra=极致；未知档位回退显示原 id）
  '低': 'Low',
  '中': 'Medium',
  '高': 'High',
  '超高': 'Extra high',
  '最大': 'Max',
  '极致': 'Ultra',
  };

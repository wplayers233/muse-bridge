<script>
  // 输入卡右下角的模型胶囊 + 一体浮层（照官方 PC 端 composer：模型名 + ⌄，点开浮层选模型，
  // 换了带思考深度档的模型再进二级视图选档——同一张浮层里翻页，不是两颗下拉框）。
  // effort 滑条照 components/EffortPanel.svelte（claude.ai/code 官方逆向复刻）整段移植：
  // 拖拽物理 / HSE 吸附缓动 / 档名交换动画 / 顶档 WebGL 能量场（紫→本页 --agent-accent 染色）。
  // 数据源不同：这里走 lib/cliChat 的 cliModels（codex model/list），不是 Claude 的 caps/settings；
  // 改档提交后不关浮层（Claude 官方同款，面板留驻、档名即时更新）。两处各自持有同构实现，互指来源。
  import { cubicOut } from 'svelte/easing';
  import { cliModels, modelOf, effortOf, setCliModel } from '../../lib/cliChat.svelte.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  let { agent = 'codex', disabled = false } = $props();

  let open = $state(false);
  let view = $state('models');   // 'models' | 'effort'
  let busy = $state(false);
  let dir = $state('up');
  let pillBtn = $state(null);

  const list = $derived(cliModels.list || []);
  const visible = $derived(list.filter((m) => !m.hidden));
  const curModel = $derived(modelOf(agent));
  const curEffort = $derived(effortOf(agent));
  const picked = $derived(visible.find((m) => m.id === curModel) || null);
  // 胶囊上显示当前模型；没挑过（走 CLI 自己的配置）就显示「默认」。
  const pillLabel = $derived(curModel ? (picked?.label || curModel) : t('默认'));
  // 思考深度档以【选中的模型】自己报的为准（各模型能给的档不一样）。
  const efforts = $derived(picked?.efforts || []);

  // —— effort 档位中文名：字面量 switch（i18n-check 要求 t() 的键静态可查）；
  // 未知档位回退显示原 id。——
  function effortName(v) {
    switch (v) {
      case 'low': return t('低');
      case 'medium': return t('中');
      case 'high': return t('高');
      case 'xhigh': return t('超高');
      case 'max': return t('最大');
      case 'ultra': return t('极致');
      default: return v;
    }
  }

  // —— 滑条数据（照 EffortPanel 的 efforts 形状 {id, name}）——
  const items = $derived(efforts.map((id) => ({ id, name: effortName(id) })));
  const N = $derived(items.length);
  // 当前生效档的位置：''（默认）时视觉停在模型默认档（没有就第 0 档）。
  const idx = $derived.by(() => {
    if (curEffort !== '') {
      const i = efforts.indexOf(curEffort);
      if (i >= 0) return i;
    }
    const d = efforts.indexOf(picked?.defaultEffort);
    return d >= 0 ? d : 0;
  });
  // 顶档 = accent 档（Claude 只给 Ultracode 上紫；这里顶档一律上各家 accent）
  const accentIdx = $derived(N - 1);
  const accent = $derived(N > 1);

  // 拖动中的高亮档（官方 onValueChange 只改高亮、onValueCommitted 才落值）
  let hlIdx = $state(null);
  const disp = $derived(hlIdx == null ? idx : hlIdx);
  const restPct = $derived(N > 1 ? (disp / (N - 1)) * 100 : 0);
  const topStop = $derived(accent && disp === accentIdx);
  const label = $derived((items[disp] || {}).name || '');

  let dragging = $state(false);
  let control = $state(), trackEl = $state(), fillEl = $state(), thumbEl = $state(), railEl = $state(), inputEl = $state(), canvasEl = $state();

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 官方自定义弹性缓动（hse）：400ms linear() 前 48% 完成、尾段驻留
  const HSE = '400ms linear(0, 0.0497, 0.1647, 0.3069, 0.4517, 0.5848, 0.6991, 0.7923, 0.8647, 0.9186, 0.9571, 0.9831, 0.9996, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)';

  function commit(i) {
    const e = efforts[i];
    // 改档不关浮层（Claude 官方同款）；失败走 pickEffort 里的 toast，档名落回实况。
    if (e != null && e !== curEffort) pickEffort(e);
    hlIdx = null;
  }

  // —— 档名交换动画（官方 framer popLayout 逐行对位：0.2s easeOut、±0.55em、blur 2px）——
  let lbDir = $state(1);
  function setDisp(i) {
    if (i === disp) return;
    lbDir = i > disp ? 1 : -1;
    hlIdx = i;
  }
  const lbIn = (n, { d }) => ({ duration: 200, easing: cubicOut, css: (p, u) => `opacity:${p};filter:blur(${(2 * u).toFixed(2)}px);transform:translateY(${(0.55 * u * d).toFixed(3)}em)` });
  const lbOut = (n, { d }) => ({ duration: 200, easing: cubicOut, css: (p, u) => `position:absolute;left:0;top:0;max-width:100%;opacity:${p};filter:blur(${(2 * u).toFixed(2)}px);transform:translateY(${(-0.55 * u * d).toFixed(3)}em)` });

  // —— 拖拽（官方逐行移植：railRect 定位、thumb 抓取偏移、3px 起判、catchUp 100ms cubic-out、
  //    松手 |raw-target|≥0.5px 才播吸附动画）——
  let st = null;   // { railRect, grabOffsetX, downClientX, lastClientX, rafId, moved, catchUp }
  let endCb = null;
  const frac = () => Math.min(Math.max((st.lastClientX - st.grabOffsetX - st.railRect.left) / (st.railRect.width || 1), 0), 1);
  function setTransitions() {
    if (reduced()) { fillEl.style.transition = ''; thumbEl.style.transition = ''; return; }
    fillEl.style.transition = `width ${HSE}`;
    thumbEl.style.transition = `left ${HSE}, background-color 300ms`;
  }
  function clearEndCb() { if (endCb) { thumbEl.removeEventListener('transitionend', endCb); endCb = null; } }
  function down(e) {
    if (N < 2 || e.button !== 0) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    clearEndCb();
    setTransitions();
    control.style.removeProperty('--slider-drag-pos');
    const trRect = thumbEl.getBoundingClientRect();
    const onThumb = thumbEl.contains(e.target);
    st = { railRect: railEl.getBoundingClientRect(), grabOffsetX: onThumb ? e.clientX - (trRect.left + trRect.width / 2) : 0,
      downClientX: e.clientX, lastClientX: e.clientX, rafId: 0, moved: false, catchUp: null };
    // 点按（未拖）：目标档即刻成为高亮 → rest-pos 变化经 hse 过渡滑过去（官方 base-ui 同构）
    setDisp(Math.round(frac() * (N - 1)));
  }
  function tick() {
    if (!st || !control || !railEl) return;
    st.rafId = 0;
    st.railRect = railEl.getBoundingClientRect();
    const a = frac();
    let r = a;
    if (st.catchUp) {
      const k = Math.min((performance.now() - st.catchUp.startTime) / 100, 1);
      if (k >= 1) st.catchUp = null;
      else { const n = 1 - (1 - k) ** 3; r = st.catchUp.fromFraction + (a - st.catchUp.fromFraction) * n; }
    }
    control.style.setProperty('--slider-drag-pos', (100 * r) + '%');
    setDisp(Math.round(r * (N - 1)));
    if (st.catchUp && st.rafId === 0) st.rafId = requestAnimationFrame(tick);
  }
  function move(e) {
    if (!st) return;
    st.lastClientX = e.clientX;
    if (e.buttons === 0) { up(); return; }
    if (!st.moved) {
      if (Math.abs(e.clientX - st.downClientX) < 3) return;
      st.moved = true; dragging = true;
      const w = control.getBoundingClientRect().width;
      if (w > 0 && !reduced()) {
        const from = Math.min(Math.max(fillEl.getBoundingClientRect().width / w, 0), 1);
        control.style.setProperty('--slider-drag-pos', (100 * from) + '%');
        st.catchUp = { fromFraction: from, startTime: performance.now() };
      }
      fillEl.style.transition = ''; thumbEl.style.transition = '';
    }
    if (st.rafId === 0) st.rafId = requestAnimationFrame(tick);
  }
  function up() {
    const g = st;
    st = null; dragging = false;
    if (!g || !control || !fillEl || !thumbEl) return;
    if (g.rafId !== 0) cancelAnimationFrame(g.rafId);
    const raw = (() => { st = g; const v = frac(); st = null; return v; })();
    if (!g.moved) {
      // 点按：hse 过渡已在滑，落值 + transitionend 清理
      commit(disp);
      const done = (ev) => { if (ev && ev.propertyName !== 'left') return; clearEndCb(); fillEl.style.transition = ''; thumbEl.style.transition = ''; };
      if (thumbEl.getAnimations().length > 0) { endCb = done; thumbEl.addEventListener('transitionend', done); } else done();
      control.style.removeProperty('--slider-drag-pos');
      return;
    }
    const target = Math.round(raw * (N - 1));
    commit(target);
    const d = N > 1 ? target / (N - 1) : 0;
    if (Math.abs(raw - d) * (g.railRect.width || 1) < 0.5 || reduced()) { control.style.removeProperty('--slider-drag-pos'); return; }
    const done = (ev) => {
      if (ev && ev.propertyName !== 'left') return;
      clearEndCb(); fillEl.style.transition = ''; thumbEl.style.transition = ''; control.style.removeProperty('--slider-drag-pos');
    };
    setTransitions();
    control.style.setProperty('--slider-drag-pos', (100 * d) + '%');
    endCb = done;
    thumbEl.addEventListener('transitionend', done);
  }
  function dotTap(e, i) {
    e.stopPropagation();
    clearEndCb(); setTransitions();
    control.style.removeProperty('--slider-drag-pos');
    setDisp(i); commit(i);
    const done = (ev) => { if (ev && ev.propertyName !== 'left') return; clearEndCb(); fillEl.style.transition = ''; thumbEl.style.transition = ''; };
    endCb = done; thumbEl.addEventListener('transitionend', done);
  }
  // 键盘（隐藏 input）：官方即时落值、无动画
  function onInput() { const i = +inputEl.value; setDisp(i); commit(i); }

  // —— WebGL2 能量场（EffortPanel 官方 pse 宿主逐行移植 + shader 原文；染色走 CSS token）——
  const VERT = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
uniform vec2 u_resolution;
void main() {
  v_uv = (a_position * 0.5 + 0.5) * u_resolution;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;
  const FRAG = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_fg;
uniform vec3 u_fg2;
uniform float u_seed;
const int MAX_BURSTS = 8;
uniform float u_burstTime[MAX_BURSTS];
uniform vec2  u_burstCenter[MAX_BURSTS];
uniform float u_burstGain[MAX_BURSTS];
uniform float u_fade;
uniform float u_pos;
uniform vec4 u_charge0;
uniform vec4 u_charge1;
uniform float u_bedFill;
uniform vec4 u_tintA;
uniform vec4 u_tintB;
in vec2 v_uv;
out vec4 fragColor;
const float CELL_PITCH = 6.0;
const float CELL_SIZE  = 4.5;
const float CELL_R     = 1.35;
const float SPEED_LO   = 20.0;
const float SPEED_HI   = 36.0;
const float RANGE_LO   = 10.0;
const float RANGE_HI   = 55.0;
const float DENSITY_LO = 0.30;
const float DENSITY_HI = 0.85;
const float JITTER     = 0.10;
const float HEAD_GAIN  = 1.25;
const float HEAD_DECAY = 5.0;
const float BODY_GAIN  = 0.65;
const float BODY_LO    = 3.3;
const float BODY_HI    = 0.77;
const float AMP_LO     = 0.55;
const float MAX_AGE    = 5.0;
const float RAMP_POW    = 1.4;
const float BREATH_DIP  = 0.28;
const float BREATH_BASE = 2.4;
const float BREATH_VARY = 1.4;
uniform float u_chargeMax;
uniform float u_chargeRamp;
uniform float u_inkFloor;
uniform float u_inkCeil;
uniform float u_energyGain;
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
void main() {
  float pitch = u_resolution.y / max(round(u_resolution.y / CELL_PITCH), 1.0);
  float cellScale = pitch / CELL_PITCH;
  vec2 cell = floor(v_uv / pitch);
  vec2 cellCenter = (cell + 0.5) * pitch;
  float cellHalf = CELL_SIZE * 0.5 * cellScale;
  float cellR = CELL_R * cellScale;
  vec2 q = abs(v_uv - cellCenter) - vec2(cellHalf - cellR);
  float distC = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - cellR;
  float aa = min(fwidth(v_uv.x), 1.5);
  float cellMask = 1.0 - smoothstep(-aa, aa, distC);
  if (cellMask <= 0.0 && u_bedFill <= 0.0) {
    fragColor = vec4(0.0);
    return;
  }
  float jitter = (hash21(cell + 41.7 + u_seed) - 0.5) * 2.0 * JITTER;
  float vary   = 0.35 + 0.65 * hash21(cell + 13.7 + u_seed);
  float energy = 0.0;
  float charged = 0.0;
  for (int i = 0; i < MAX_BURSTS; i++) {
    float age = u_time - u_burstTime[i];
    if (age < 0.0 || age > MAX_AGE) continue;
    float k = clamp(u_burstGain[i], 0.0, 1.0);
    vec2 originCell = floor(u_burstCenter[i] / pitch);
    float manh = abs(cell.x - originCell.x) + abs(cell.y - originCell.y);
    float range   = mix(RANGE_LO, RANGE_HI, k);
    float falloff = exp(-manh / (range * 0.85));
    float reach   = exp(-max(manh - range, 0.0) * 0.12);
    float speed   = mix(SPEED_LO, SPEED_HI, k);
    float t = age - manh / speed - jitter;
    charged = max(charged, smoothstep(0.0, 0.15, t) * reach);
    if (t < 0.0) continue;
    float rank = hash21(cell + 7.3 + u_seed + u_burstTime[i]);
    if (rank > mix(DENSITY_LO, DENSITY_HI, k)) continue;
    float head = HEAD_GAIN * exp(-t * HEAD_DECAY);
    float body = BODY_GAIN * exp(-t * mix(BODY_LO, BODY_HI, k));
    energy += (head + body) * mix(AMP_LO, 1.0, k) * falloff * reach * vary;
  }
  float lumA = hash21(cell + 8.8 + u_seed);
  float lumB = hash21(cell + 88.8 + u_seed);
  float lumDrift = 0.5 + 0.5 * sin(u_time * 0.35 + lumA * 6.2832);
  float lum = pow(mix(lumA, lumB, lumDrift), 1.9);
  float stream = 0.9 + 0.16 * sin(u_time * 1.3 + cell.x * 0.45 + lumB * 2.0);
  float e = clamp(energy, 0.0, 1.0) * u_fade * mix(0.16, 1.0, lum) * stream
    * u_energyGain;
  float g = clamp(v_uv.x / max(u_pos * u_resolution.x, 1.0), 0.0, 1.0);
  vec3 chargeColor = mix(u_charge0.rgb, u_charge1.rgb, g);
  float bedMask = mix(u_bedFill, 1.0, cellMask);
  float chargeA = u_chargeMax * pow(g, u_chargeRamp) * charged * u_fade
    * bedMask * mix(u_charge0.a, u_charge1.a, g);
  float lv = step(0.04, e) + step(0.2, e) + step(0.4, e) + step(0.6, e) + step(0.8, e);
  float alpha = lv <= 0.0 ? 0.0 : mix(u_inkFloor, u_inkCeil, (lv - 1.0) / 4.0);
  if (lv >= 5.0) {
    float period = BREATH_BASE + BREATH_VARY * hash21(cell + 3.1 + u_seed);
    float phase = hash21(cell + 5.5 + u_seed) * 6.2832;
    alpha *= 1.0 - BREATH_DIP * 0.5 * (1.0 + sin(u_time * 6.2832 / period + phase));
  }
  vec3 ink = mix(u_fg2, u_fg, pow(lv / 5.0, RAMP_POW));
  float hueSel = hash21(cell + 27.9 + u_seed);
  ink = mix(ink, u_tintA.rgb, u_tintA.a * smoothstep(0.62, 0.95, hueSel));
  ink = mix(ink, u_tintB.rgb, u_tintB.a * (1.0 - smoothstep(0.05, 0.38, hueSel)));
  float eA = alpha * cellMask;
  vec3 col = ink * eA + chargeColor * chargeA * (1.0 - eA);
  float a = eA + chargeA * (1.0 - eA);
  if (a <= 0.0) {
    fragColor = vec4(0.0);
    return;
  }
  fragColor = vec4(col, a);
}
`;
  let energyApi = null;   // { pressStart(k), pressEnd(k) }
  $effect(() => {
    const cnv = canvasEl;
    if (!cnv || !accent) return;
    const gl = cnv.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return;
    const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    const prog = gl.createProgram();
    const vs = mk(gl.VERTEX_SHADER, VERT), fs = mk(gl.FRAGMENT_SHADER, FRAG);
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { gl.deleteProgram(prog); return; }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_position');
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const U = (n) => gl.getUniformLocation(prog, n);
    const uTime = U('u_time'), uRes = U('u_resolution'), uSeed = U('u_seed'), uPos = U('u_pos'),
      uC0 = U('u_charge0'), uC1 = U('u_charge1'), uBed = U('u_bedFill'), uCMax = U('u_chargeMax'),
      uCRamp = U('u_chargeRamp'), uFloor = U('u_inkFloor'), uCeil = U('u_inkCeil'), uGain = U('u_energyGain'),
      uTA = U('u_tintA'), uTB = U('u_tintB'), uFg = U('u_fg'), uFg2 = U('u_fg2'),
      uBT = U('u_burstTime[0]'), uBC = U('u_burstCenter[0]'), uBG = U('u_burstGain[0]'), uFade = U('u_fade');
    gl.clearColor(0, 0, 0, 0);
    gl.uniform3fv(uFg, [0.72, 0.59, 1]); gl.uniform3fv(uFg2, [1, 1, 1]);
    gl.uniform1f(uFade, 0); gl.uniform1f(uSeed, 0); gl.uniform1f(uPos, 1);
    gl.uniform4f(uC0, 0.62, 0.5, 0.92, 1); gl.uniform4f(uC1, 0.35, 0.25, 0.6, 1);
    gl.uniform1f(uBed, 0); gl.uniform1f(uCMax, 0.85); gl.uniform1f(uCRamp, 1.1);
    gl.uniform1f(uFloor, 0.08); gl.uniform1f(uCeil, 0.85); gl.uniform1f(uGain, 1);
    gl.uniform4f(uTA, 0, 0, 0, 0); gl.uniform4f(uTB, 0, 0, 0, 0);
    const bTimes = new Float32Array(8).fill(-1000), bCenters = new Float32Array(16), bGains = new Float32Array(8);
    gl.uniform1fv(uBT, bTimes); gl.uniform2fv(uBC, bCenters); gl.uniform1fv(uBG, bGains);
    // 颜色解析探针（官方 cse/dse 等价，canvas2d 认所有 CSS 色格式）
    const pc = document.createElement('canvas'); pc.width = 1; pc.height = 1;
    const px = pc.getContext('2d', { willReadFrequently: true });
    const parse = (c, fb) => { try { px.clearRect(0, 0, 1, 1); px.fillStyle = '#000'; px.fillStyle = c; px.fillRect(0, 0, 1, 1);
      const d = px.getImageData(0, 0, 1, 1).data; return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255]; } catch { return fb; } };
    let slot = 0, T = false, E = 0, fade = 0, hold = 0;
    let W = 1, H = 1, dirty = true, raf = 0, running = false, prev = 0;
    let lastBurstU = -1 / 0, lastBurstWall = -1 / 0, nextGap = 0.45, hiddenHeld = false, Utime = 0;
    const rm = matchMedia('(prefers-reduced-motion: reduce)');
    const gain = (e, k) => Math.min((0.15 + 0.7 * e) * (0.45 + 0.55 * k), 1);
    const draw = () => {
      if (dirty) { gl.viewport(0, 0, cnv.width, cnv.height); gl.uniform2f(uRes, W, H); dirty = false; }
      gl.uniform1f(uTime, Utime); gl.uniform1f(uPos, Math.max(E, 0.02));
      gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    const alive = () => Utime - lastBurstU < 5;
    const frame = (now) => {
      const dt = 0.001 * (now - prev);
      Utime += dt; prev = now;
      fade = T ? Math.min(fade + dt / 0.7, 1) : Math.max(fade - dt / 0.85, 0);
      hold = T ? hold + dt : 0;
      if (T && Utime - lastBurstU > nextGap) {
        const h = Math.min(hold / 1.6, 1);
        nextGap = 0.3 + 0.45 * Math.random();
        emit(gain(E, h) * (0.85 + 0.3 * Math.random()), E + 0.08 * (Math.random() - 0.5));
      }
      const s = fade * fade * (3 - 2 * fade);
      gl.uniform1f(uFade, s);
      draw();
      if ((T || (alive() && fade > 0)) && !document.hidden) raf = requestAnimationFrame(frame);
      else running = false;
    };
    const start = () => { if (!running) { running = true; prev = performance.now(); raf = requestAnimationFrame(frame); } };
    const stopLoop = () => { if (running) { running = false; cancelAnimationFrame(raf); } };
    const size = (w, h, dpr) => {
      const rw = Math.max(1, w), rh = Math.max(1, h);
      if (rw !== W || rh !== H) {
        const ex = rw / W, ey = rh / H;
        for (let i = 0; i < 8; i++) { bCenters[2 * i] *= ex; bCenters[2 * i + 1] *= ey; }
        gl.uniform2fv(uBC, bCenters); W = rw; H = rh; dirty = true;
      }
      let ow = Math.max(1, Math.round(w * dpr)), oh = Math.max(1, Math.round(h * dpr));
      if (ow * oh > 4147200) { const sc = Math.sqrt(4147200 / (ow * oh)); ow = Math.max(1, Math.round(ow * sc)); oh = Math.max(1, Math.round(oh * sc)); }
      if (cnv.width !== ow || cnv.height !== oh) { cnv.width = ow; cnv.height = oh; dirty = true; }
    };
    const emit = (k, posX) => {
      bTimes[slot] = Utime;
      bCenters[2 * slot] = posX * W;
      bCenters[2 * slot + 1] = H * (0.35 + 0.3 * Math.random());
      bGains[slot] = k;
      slot = (slot + 1) % 8;
      gl.uniform1fv(uBT, bTimes); gl.uniform2fv(uBC, bCenters); gl.uniform1fv(uBG, bGains);
      lastBurstU = Utime; lastBurstWall = performance.now();
      if (!document.hidden) start();
    };
    const refreshColors = () => {
      const cs = getComputedStyle(cnv);
      const fg = parse(cs.color, [0.72, 0.59, 1, 1]), fg2 = parse(cs.outlineColor, [1, 1, 1, 1]);
      gl.uniform3fv(uFg, fg.slice(0, 3)); gl.uniform3fv(uFg2, fg2.slice(0, 3));
      const c0 = parse(cs.borderTopColor, [0.62, 0.5, 0.92, 1]), c1 = parse(cs.borderBottomColor, [0.35, 0.25, 0.6, 1]);
      gl.uniform4f(uC0, c0[0], c0[1], c0[2], c0[3]); gl.uniform4f(uC1, c1[0], c1[1], c1[2], c1[3]);
      const ta = parse(cs.textDecorationColor, [0, 0, 0, 0]), tb = parse(cs.columnRuleColor, [0, 0, 0, 0]);
      gl.uniform4f(uTA, ta[0], ta[1], ta[2], ta[3]); gl.uniform4f(uTB, tb[0], tb[1], tb[2], tb[3]);
      const num = (n, fb) => { const v = parseFloat(cs.getPropertyValue(n)); return Number.isNaN(v) ? fb : v; };
      const cl = (v) => Math.min(Math.max(v, 0), 1);
      gl.uniform1f(uBed, cl(num('--es-energy-bed-fill', 0)));
      gl.uniform1f(uCMax, cl(num('--es-energy-charge-max', 0.85)));
      gl.uniform1f(uCRamp, Math.max(num('--es-energy-charge-ramp', 1.1), 0.01));
      gl.uniform1f(uFloor, cl(num('--es-energy-ink-floor', 0.08)));
      gl.uniform1f(uCeil, cl(num('--es-energy-ink-ceil', 0.85)));
      gl.uniform1f(uGain, Math.max(num('--es-energy-gain', 1), 0));
    };
    const ro = new ResizeObserver((es) => {
      const en = es[0], db = en.devicePixelContentBoxSize?.[0];
      if (db) { const dpr = devicePixelRatio || 1; size(db.inlineSize / dpr, db.blockSize / dpr, dpr); }
      else { const bb = en.borderBoxSize?.[0] ?? en.contentBoxSize?.[0]; size(bb?.inlineSize ?? cnv.clientWidth, bb?.blockSize ?? cnv.clientHeight, devicePixelRatio || 1); }
      draw();
    });
    ro.observe(cnv);
    const onVis = () => {
      if (document.hidden) {
        hiddenHeld = T; T = false; lastBurstU = -1 / 0; lastBurstWall = -1 / 0; fade = 0;
        bTimes.fill(-1000); gl.uniform1fv(uBT, bTimes); stopLoop(); gl.uniform1f(uFade, 0); draw();
      } else if (hiddenHeld && !rm.matches) {
        hiddenHeld = false; refreshColors(); T = true; hold = 0; emit(gain(E, 0), E);
      } else if (alive()) start();
    };
    document.addEventListener('visibilitychange', onVis);
    energyApi = {
      pressStart: (e) => {
        if (rm.matches) return;
        refreshColors();
        if (performance.now() - lastBurstWall > 5000 && fade <= 0) { bTimes.fill(-1000); gl.uniform1fv(uBT, bTimes); gl.uniform1f(uSeed, 512 * Math.random()); }
        T = true; hold = 0; E = e;
        emit(gain(e, 0), e);
      },
      pressEnd: (e) => { hiddenHeld = false; if (T) { T = false; E = e; if (!document.hidden) start(); } }
    };
    size(cnv.clientWidth || 1, cnv.clientHeight || 1, devicePixelRatio || 1);
    draw();
    return () => {
      energyApi = null; stopLoop(); ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      gl.deleteProgram(prog); gl.deleteBuffer(buf);
    };
  });

  // 顶档进出 → 能量场常按/冷却（官方 data-top-stop 语义）
  $effect(() => { if (topStop) { energyApi?.pressStart(1); return () => energyApi?.pressEnd(1); } });

  function toggle() {
    if (disabled) return;
    if (!open && pillBtn) {
      // 开之前测一下上下空间：下方够就朝下弹，不够朝上（照 Claude 页 Composer 的做法）。
      const r = pillBtn.getBoundingClientRect();
      dir = (window.innerHeight - r.bottom) >= r.top ? 'down' : 'up';
    }
    if (open) view = 'models';
    open = !open;
  }
  function close() { open = false; view = 'models'; }

  async function pickModel(id) {
    if (busy) return;
    busy = true;
    try {
      // 换模型时思考深度跟着回落：新模型未必支持旧的那一档，留着会被 CLI 拒。
      await setCliModel(agent, { model: id, effort: '' });
      if (!id) { close(); }
      else if (efforts.length) { view = 'effort'; }
      else { close(); }
    } catch (e) {
      showToast(tr(e?.message) || t('换不了这个模型'), 'err');
    }
    busy = false;
  }
  // 改档不关浮层（Claude 官方同款：滑条留驻，档名即时更新；Esc/点外随时关）。
  async function pickEffort(v) {
    if (busy) return;
    busy = true;
    try {
      await setCliModel(agent, { model: curModel, effort: v });
    } catch (e) {
      showToast(tr(e?.message) || t('换不了这个思考深度'), 'err');
    }
    busy = false;
  }
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') close(); }} />

{#if visible.length}
  <button class="pill" bind:this={pillBtn} onclick={toggle} disabled={disabled}
    class:on={open} aria-label={t('选择模型')} title={t('选择模型')}>
    <span class="plabel">{pillLabel}</span>
    {#if curModel && curEffort !== ''}<span class="peffort">{effortName(curEffort)}</span>{/if}
    <svg class="chev" class:flip={open} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 8 4.5 4.5L14.5 8"/></svg>
  </button>
  {#if open}
    <button class="pk-backdrop" aria-label={t('关闭')} onclick={close}></button>
    <div class="pk" class:down={dir === 'down'} role="menu">
      {#if view === 'effort' && accent}
        <!-- 能量场铺满整张浮层（z-index:-1 = 卡底之上、内容之下）；透明度随滑条档位渐入 -->
        <div class="es-energy-layer" style:--es-pos-pct={(N > 1 ? (disp / (N - 1)) * 100 : 100) + '%'} aria-hidden="true">
          <canvas class="es-energy" bind:this={canvasEl}></canvas>
        </div>
      {/if}
      {#if view === 'models'}
        <button class="row" onclick={() => pickModel('')} disabled={busy}>
          <span class="rname">{t('用 codex 自己的配置')}</span>
          {#if !curModel}<span class="check">✓</span>{/if}
        </button>
        <div class="div"></div>
        {#each visible as m (m.id)}
          <button class="row" onclick={() => pickModel(m.id)} disabled={busy}>
            <span class="rcol">
              <span class="rname">{m.label || m.id}</span>
              {#if m.description}<span class="rdesc">{m.description}</span>{/if}
            </span>
            {#if m.id === curModel}<span class="check accent">✓</span>{/if}
          </button>
        {/each}
      {:else}
        <!-- effort 二级视图照 Claude EffortPanel 移植：头部（↻ 复位默认 / 档名交换动画 / 模型名返回）
             + Faster/Smarter 两端 + 官方滑条（拖拽吸附）+ 顶档能量场。 -->
        <div class="ehead">
          <button class="preset" onclick={() => pickEffort('')} disabled={busy} aria-label={t('默认')} title={t('默认')}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10a6 6 0 1 1 1.8 4.3M4 10V6.5M4 10h3.5"/></svg>
          </button>
          <div class="etitle" role="button" tabindex="0"
            onclick={() => (view = 'models')} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); view = 'models'; } }}>
            <span class="evalwrap">
              {#key disp}<span class="ename" class:accent={topStop} in:lbIn={{ d: lbDir }} out:lbOut={{ d: lbDir }}>{label}</span>{/key}
            </span>
            <span class="emodel">{picked?.label || curModel} ›</span>
          </div>
        </div>
        {#if N >= 2}
          <div class="es-sec">
            <div class="es-ends"><span>Faster</span><span>Smarter</span></div>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="es-slider" class:dragging class:topstop={topStop} bind:this={control}
              style:--slider-rest-pos={restPct + '%'}
              onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onlostpointercapture={up}>
              <div class="es-track" bind:this={trackEl}>
                <span class="es-fill" bind:this={fillEl}></span>
              </div>
              <span class="es-dots" aria-hidden="true">
                {#each items as it, i (it.id)}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <span class="es-dot" class:last={i === accentIdx} style:--ds={35 * (N - 1 - i) + 'ms'} title={it.name}
                    onpointerdown={(ev) => dotTap(ev, i)}><span class="es-dot-hit"></span></span>
                {/each}
              </span>
              <span class="es-rail" bind:this={railEl}>
                <span class="es-thumb" bind:this={thumbEl} aria-hidden="true"></span>
                <span class="es-thumb es-focusring" aria-hidden="true"></span>
                <input class="es-input" bind:this={inputEl} type="range" min="0" max={N - 1} step="1" value={disp}
                  aria-label={t('思考深度')} aria-valuetext={label} oninput={onInput} />
              </span>
            </div>
          </div>
        {:else if N === 1}
          <button class="row" onclick={() => pickEffort(efforts[0])} disabled={busy}>
            <span class="rname">{items[0].name}</span>
            {#if curEffort === efforts[0]}<span class="check accent">✓</span>{/if}
          </button>
        {/if}
      {/if}
    </div>
  {/if}
{/if}

<style>
  /* 胶囊：官方 PC 端 composer 同款（模型名 + ⌄，30px 高、全圆角、弱底色） */
  .pill {
    display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 10px 0 12px;
    border-radius: 999px; border: none; color: inherit; max-width: 180px;
    background: color-mix(in srgb, currentColor 8%, transparent); flex: none;
  }
  .pill:disabled { opacity: .5; }
  .plabel { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .peffort { font-size: 11px; opacity: .6; flex: none; }
  .chev { width: 13px; height: 13px; flex: none; opacity: .65; transition: transform .15s ease; }
  .chev.flip { transform: rotate(180deg); }

  .pk-backdrop { position: fixed; inset: 0; z-index: 60; }
  .pk {
    position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 61;
    min-width: 240px; max-width: min(320px, calc(100vw - 32px)); padding: 4px;
    max-height: 50vh; overflow-y: auto;
    display: flex; flex-direction: column;
    background: var(--q-card, var(--card, #2c2c2a)); border-radius: 14px;
    box-shadow: var(--q-shadow, 0 8px 28px rgba(0,0,0,.35));
  }
  .pk.down { bottom: auto; top: calc(100% + 8px); }
  .row { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 9px; text-align: left; }
  @media (hover: hover) { .row:hover { background: color-mix(in srgb, currentColor 8%, transparent); } }
  .row:active { background: color-mix(in srgb, currentColor 10%, transparent); }
  .rcol { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .rname { font-size: 13px; color: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rdesc { font-size: 11px; opacity: .6; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .check { margin-left: auto; flex: none; font-size: 13px; }
  .check.accent { color: var(--agent-accent, currentColor); }
  .div { height: 1px; background: color-mix(in srgb, currentColor 12%, transparent); margin: 4px 8px; }

  /* —— effort 视图头部：↻ 复位默认 / 档名（交换动画）/ 模型名（点击返回）—— */
  .ehead { position: relative; display: flex; align-items: center; justify-content: center; padding: 10px 12px 4px; min-height: 34px; }
  .preset { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 28px; height: 28px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center; color: inherit; opacity: .55; }
  .preset svg { width: 15px; height: 15px; }
  @media (hover: hover) { .preset:hover { opacity: 1; background: color-mix(in srgb, currentColor 8%, transparent); } }
  .etitle { display: flex; flex-direction: column; align-items: center; gap: 1px; cursor: pointer; border-radius: 8px; padding: 2px 10px; }
  .evalwrap { position: relative; display: flex; min-width: 0; }
  .ename { display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    font-size: 15px; font-weight: 500; color: inherit; }
  .ename.accent { color: var(--es-accent, var(--agent-accent, currentColor)); }
  .emodel { font-size: 11.5px; opacity: .6; }
  @media (hover: hover) { .etitle:hover .emodel { opacity: 1; text-decoration: underline; text-underline-offset: 2px; } }

  /* ===== effort 滑条（EffortPanel 官方复刻移植，类名 ef- → es-；token 紫改本页 accent）===== */
  .pk {
    --es-accent: var(--agent-accent, currentColor);
    --es-accent-20: color-mix(in srgb, var(--agent-accent, currentColor) 20%, transparent);
    --es-pop-shadow: inset 0 0 0 1px rgba(255, 255, 255, .08), 0 6px 16px rgba(11, 11, 11, .24);
    --es-t5: rgba(255, 255, 255, .25);
    --es-t6: rgba(255, 255, 255, .48);
    --es-t7: rgba(255, 255, 255, .7);
    --es-slider-background: rgb(26, 26, 25);
    --es-slider-fill: rgba(255, 255, 255, .16);
    --es-slider-handle: rgb(165, 164, 154);
    --es-slider-handle-energized: color-mix(in srgb, var(--agent-accent, currentColor) 25%, #fff);
    --es-thumb-shadow: 0 0 12px rgba(11, 11, 11, .24);
    --es-energy-hot: color-mix(in srgb, var(--agent-accent, currentColor) 45%, #fff);
    --es-energy-cool: rgb(255, 255, 255);
    --es-energy-charged-start: color-mix(in srgb, var(--agent-accent, currentColor) 50%, #fff);
    --es-energy-charged-end: var(--agent-accent, currentColor);
    --es-energy-tint-blue: transparent;
    --es-energy-tint-pink: transparent;
    --es-energy-bed-fill: 0;
    --es-energy-charge-max: .85;
    --es-energy-charge-ramp: 1.1;
    --es-energy-ink-floor: .12;
    --es-energy-ink-ceil: .95;
    --es-energy-gain: 1.2;
    --es-energy-op-k: 1.15;     /* 暗：opacity clamp 系数与上限（accent 明度低于官方紫，放宽才可见） */
    --es-energy-op-max: 85%;
  }
  :global(html[data-theme="light"]) .pk {
    --es-pop-shadow: 0 0 0 1px rgba(11, 11, 11, .06), 0 6px 16px rgba(11, 11, 11, .06);
    --es-t5: rgba(11, 11, 11, .25);
    --es-t6: rgba(11, 11, 11, .5);
    --es-t7: rgba(11, 11, 11, .8);
    --es-slider-background: rgb(237, 236, 232);
    --es-slider-fill: rgba(11, 11, 11, .1);
    --es-slider-handle: #fff;
    --es-slider-handle-energized: #fff;
    --es-thumb-shadow: 0 0 0 1px rgba(11, 11, 11, .04), 0 0 12px rgba(11, 11, 11, .06);
    --es-energy-hot: color-mix(in srgb, var(--agent-accent, currentColor) 45%, #fff);
    --es-energy-cool: rgb(210, 196, 240);
    --es-energy-bed-fill: 1;
    --es-energy-charge-max: .92;
    --es-energy-charge-ramp: .5;
    --es-energy-ink-floor: .28;
    --es-energy-ink-ceil: 1;
    --es-energy-gain: 1.35;
    --es-energy-op-k: 1.5;
    --es-energy-op-max: 100%;
  }

  .es-sec { display: flex; width: 100%; flex-direction: column; gap: 8px; padding: 8px 10px 10px; font-size: 13px; line-height: 18px; user-select: none; }
  .es-ends { display: flex; align-items: center; justify-content: space-between; gap: 4px;
    font-size: 12px; line-height: 15px; color: var(--es-t6); }

  /* control 24 高；track 20 高 r6 上下 margin 2 */
  .es-slider { position: relative; display: flex; height: 24px; width: 100%; align-items: center; touch-action: none; }
  .es-slider.dragging { cursor: ew-resize; }
  .es-track { position: relative; width: 100%; margin: 2px 0; height: calc(100% - 4px); border-radius: 6px;
    overflow: hidden; container-type: inline-size; background: var(--es-slider-background); }
  .es-fill { position: absolute; inset: 0 auto 0 0; left: 0; overflow: hidden;
    width: var(--slider-drag-pos, var(--slider-rest-pos)); background: var(--es-slider-fill); }
  /* 能量层：铺满整张浮层；透明度沿用官方 clamp((pos-25%)*k)，pos 由模板按 disp 响应式写入 */
  .es-energy-layer { position: absolute; inset: 0; z-index: -1; border-radius: inherit; overflow: hidden; pointer-events: none;
    opacity: clamp(0%, calc((var(--es-pos-pct, 100%) - 25%) * var(--es-energy-op-k)), var(--es-energy-op-max)); }
  :global(html:not([data-theme="light"])) .pk .es-energy-layer { mix-blend-mode: plus-lighter; }
  .es-energy { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;
    color: var(--es-energy-hot); outline-color: var(--es-energy-cool);
    border-top: 0 none var(--es-energy-charged-start); border-bottom: 0 none var(--es-energy-charged-end);
    text-decoration-color: var(--es-energy-tint-blue); column-rule-color: var(--es-energy-tint-pink); }

  /* 档位点：3px、px 10 两端、t5（末档 accent）、35ms 步进错峰；顶档非拖动隐去；命中区 19×23 */
  .es-dots { pointer-events: none; position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: space-between; padding: 0 10px; }
  .es-dot { pointer-events: auto; position: relative; display: flex; width: 3px; height: 3px;
    align-items: center; justify-content: center; border-radius: 999px; background: var(--es-t5); }
  .es-dot.last { background: var(--es-accent); }
  .es-dot-hit { position: absolute; inset: -10px -8px; }
  @media (prefers-reduced-motion: no-preference) {
    .es-dot { transition: opacity .3s ease var(--ds, 0ms); }
  }
  .es-slider.dragging .es-dot { pointer-events: none; }
  .es-slider.topstop .es-dot { pointer-events: none; }
  .es-slider.topstop:not(.dragging) .es-dot { opacity: 0; }

  /* 轨内滑轨：两侧内缩半把手（8px）；把手 16×19 r6，背景色 300ms 过渡 */
  .es-rail { pointer-events: none; position: absolute; top: 0; bottom: 0; left: 8px; right: 8px; }
  .es-thumb { pointer-events: auto; position: absolute; width: 16px; height: 19px; border-radius: 6px;
    left: var(--slider-drag-pos, var(--slider-rest-pos)); top: 50%; transform: translate(-50%, -50%);
    background: var(--es-slider-handle); box-shadow: var(--es-thumb-shadow); cursor: ew-resize; }
  @media (prefers-reduced-motion: no-preference) {
    .es-thumb { transition: background-color .3s; }
  }
  .es-slider.topstop .es-thumb { background: var(--es-slider-handle-energized); }
  /* 键盘聚焦环：accent 2px + 环 4px + 20% 辉光（官方 shadow-focus-slider） */
  .es-focusring { pointer-events: none; opacity: 0; background: transparent; cursor: default;
    box-shadow: 0 0 0 2px var(--q-card, #2c2c2a), 0 0 0 4px var(--es-accent), 0 0 14px 4px var(--es-accent-20); }
  .es-slider:focus-within .es-focusring { opacity: 1; }
  /* 真 input：藏在把手位置承载键盘/读屏（官方 clip 内藏 input 同构） */
  .es-input { position: absolute; width: 16px; height: 19px; top: 50%;
    left: var(--slider-drag-pos, var(--slider-rest-pos)); transform: translate(-50%, -50%);
    opacity: 0; pointer-events: none; margin: 0; }
</style>

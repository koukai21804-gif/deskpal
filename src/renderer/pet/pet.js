// 宠物窗主逻辑：情绪状态机 / 动画 / 拖拽 / 菜单 / 气泡 / 睡觉 / 空闲小动作 / 提醒音
import { dp, initTheme, applyTheme } from '../common/ipc.js';
import { renderPet, EMOTION_KEYS } from './sprite.js';
import * as bubble from './bubble.js';
import { pick, clickLines, idleLine, petName, masterName } from './lines.js';
import './menu.js';

const stage = document.querySelector('.dp-stage');
const spriteEl = document.querySelector('.dp-sprite');

// 立即渲染一个默认 SVG 球体占位：形象配置与图片解码就绪前不留空白
renderPet(spriteEl, 'normal', { mode: 'svg' });

// ---------- 状态 ----------
let emotion = 'normal';          // 当前渲染表情
let persistent = 'normal';       // 上一个持久表情（临时情绪回退目标）
let sprites = { slots: {} };     // 差分图映射
let persona = null;              // 人设（点击台词/名字实时跟随设置变化）
let sleeping = false;
let revertTimer = null;

const PRIORITY = { user: 5, schedule: 4, reader: 3, chat: 2, idle: 1 };
let curSource = 'idle';

function slotOf(emo) { return (sprites.slots && sprites.slots[emo]) || { mode: 'svg' }; }

export function setEmotion(emo, { source = 'user', revertMs = 0 } = {}) {
  if (!EMOTION_KEYS.includes(emo)) return;
  // 优先级：user > schedule > reader > chat > idle；低优先级不打断高优先级
  const newP = PRIORITY[source] || 0;
  if (currentPriority() > newP && revertTimer) return;
  curSource = source;
  if (!revertTimer) persistent = emotion; // 记住持久表情

  emotion = emo;
  render();
  bounce();

  if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
  if (revertMs > 0) {
    revertTimer = setTimeout(() => {
      revertTimer = null;
      emotion = persistent;
      render();
    }, revertMs);
  } else {
    persistent = emo; // 无回退 → 成为持久表情
  }
}

let priorityHold = 0;
function currentPriority() { return PRIORITY[curSource] || 0; }

function render() {
  renderPet(spriteEl, emotion, slotOf(emotion));
  if (sleeping) spriteEl.classList.add('sleeping');
  document.querySelectorAll('.dp-emodots span').forEach(d => d.classList.toggle('active', d.dataset.emo === emotion));
}

function bounce() {
  if (dragging) return;
  spriteEl.classList.remove('bounce');
  void spriteEl.offsetWidth;
  spriteEl.classList.add('bounce');
}

// ---------- 眨眼（仅 SVG 模式） ----------
function scheduleBlink() {
  setTimeout(() => {
    if (!sleeping && slotOf(emotion).mode !== 'image') {
      spriteEl.classList.remove('blink');
      void spriteEl.offsetWidth;
      spriteEl.classList.add('blink');
    }
    scheduleBlink();
  }, 3000 + Math.random() * 3000);
}

// ---------- 拖拽（主进程光标跟随） ----------
// 渲染层只做「按下 / 位移阈值 / 抬起」判定并上报 start/end；
// 窗口移动由主进程定时器读取系统光标完成（client 坐标随窗口移动会形成反馈回路，不能用来测位移）
let dragging = false, downPos = null, moved = false;

spriteEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  downPos = { x: e.clientX, y: e.clientY };
  moved = false;
  try { spriteEl.setPointerCapture(e.pointerId); } catch (_) {}
});
spriteEl.addEventListener('pointermove', (e) => {
  if (!downPos || moved) return;
  if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) < 5) return;
  moved = true;
  dragging = true;
  spriteEl.classList.add('dragging');
  // 抓取点用 pointerdown 时的 client 坐标（此刻窗口未动，client 即抓取点 DIP 位置），
  // 避免 start 消息到达主进程的延迟造成抓取点偏差
  dp.invokePetDrag('start', { gx: downPos.x, gy: downPos.y }); // 越过阈值后主进程接管，窗口贴住光标移动
});
async function endDrag(e) {
  if (!downPos) return;
  const wasClick = !moved;
  downPos = null;
  if (moved) {
    dragging = false;
    spriteEl.classList.remove('dragging');
    dp.invokePetDrag('end');
    return;
  }
  if (wasClick && e.button === 0) {
    // 单击：挥手台词（口头禅优先来自人设；台词带 [表情] 标签时同步切换对应差分图）
    if (!sleeping) {
      const line = pick(clickLines(persona));
      setEmotion(line.emotion || (Math.random() < 0.6 ? 'happy' : 'normal'), { source: 'user', revertMs: 6000 });
      bubble.replace({ kind: 'text', text: line.text });
    } else {
      wakeUp();
    }
  }
}
spriteEl.addEventListener('pointerup', endDrag);
spriteEl.addEventListener('pointercancel', () => {
  if (moved) { dragging = false; spriteEl.classList.remove('dragging'); dp.invokePetDrag('end'); }
  downPos = null;
});

// 双击 → 聊天窗
spriteEl.addEventListener('dblclick', () => { dp.openWindow('chat'); });

// ---------- 睡觉 ----------
function sleep() {
  sleeping = true;
  if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; } // 清掉挂起的临时表情回退，避免睡觉中被拉回
  spriteEl.classList.add('sleeping');
  spriteEl.classList.remove('breathing');
  bubble.clearAll();
  // 复用 thinking 的半垂眼睑：直接切 thinking 表情
  emotion = 'thinking';
  render();
}
// 睡觉唤醒台词
function wakeUp() {
  sleeping = false;
  spriteEl.classList.remove('sleeping');
  spriteEl.classList.add('breathing');
  // 睡觉表情是临时借用，不进入状态机：先把回退目标归位平常，
  // 否则唤醒后的 happy 回退会回到 thinking，看起来像没睡醒
  emotion = 'normal';
  setEmotion('happy', { source: 'user', revertMs: 4000 });
  bubble.replace({ kind: 'text', text: `呼哇…${petName(persona)}睡得真好！${masterName(persona)}找我什么事？` });
  // 单击唤醒也要同步清除持久化标记，否则下次启动带着残留的睡觉状态起跳
  dp.storeSet('settings', { pet: { sleep: false } }).catch(() => {});
}

// ---------- 提示音 ----------
let dingAudio = null;
async function loadDing() {
  try {
    const url = await dp.getDingUrl();
    if (url) dingAudio = new Audio(url);
  } catch (_) {}
}
function playDing() {
  if (dingAudio) { dingAudio.volume = 0.6; dingAudio.currentTime = 0; dingAudio.play().catch(() => {}); }
}

// ---------- 空闲小动作（活跃时段 9:00-22:00，每 10~20 分钟） ----------
function scheduleIdleAction() {
  setTimeout(() => {
    const h = new Date().getHours();
    if (h >= 9 && h < 22 && !sleeping) {
      setEmotion(pick(['normal', 'happy', 'thinking']), { source: 'idle' });
      bubble.replace({ kind: 'text', text: idleLine(persona), seconds: 5 });
    }
    scheduleIdleAction();
  }, (10 + Math.random() * 10) * 60 * 1000);
}

// ---------- 人设 / 缩放实时跟随设置变化 ----------
async function loadPersona() {
  try { persona = await dp.storeGet('persona'); } catch (_) { persona = null; }
}

async function applyScale() {
  try {
    const settings = await dp.storeGet('settings');
    document.documentElement.style.setProperty('--pet-scale', settings.pet.scale || 1);
  } catch (_) {}
}

// ---------- IPC 订阅 ----------
dp.on('pet:emotion', ({ emotion: emo, source, revertMs }) => {
  if (sleeping) return;
  setEmotion(emo, { source: source || 'chat', revertMs: revertMs || 0 });
});
dp.on('pet:bubble', (b) => {
  if (sleeping && b.kind === 'text') return;
  bubble.push(b);
});
dp.on('pet:sleep', ({ on }) => { on ? sleep() : (sleeping && wakeUp()); });
dp.on('pet:ding', () => playDing());
dp.on('theme:changed', applyTheme);
dp.on('sprites:changed', async () => { sprites = await dp.spritesGet(); render(); });
dp.on('settings:changed', ({ name } = {}) => {
  if (name === 'persona') loadPersona();
  if (name === 'settings') applyScale();
});

// ---------- 启动 ----------
async function boot() {
  await initTheme();
  await loadPersona();
  const settings = await dp.storeGet('settings');
  sprites = await dp.spritesGet();
  document.documentElement.style.setProperty('--pet-scale', settings.pet.scale || 1);
  bubble.setBubbleSeconds(settings.pet.bubbleSeconds || 6);
  // 睡觉是临时状态，不跨启动保留：每次启动都以默认「平常」示人；
  // 顺手清掉残留的 sleep 标记（上次退出时在睡觉 / 单击唤醒未同步），保持设置与实际一致
  if (settings.pet.sleep) dp.storeSet('settings', { pet: { sleep: false } }).catch(() => {});
  spriteEl.classList.add('breathing');
  render();
  scheduleBlink();
  scheduleIdleAction();
  loadDing();
  // 开机问候
  setTimeout(() => {
    if (!sleeping) bubble.replace({ kind: 'text', text: pick([`我回来啦！`, `${petName(persona)}在，${masterName(persona)}请吩咐～`]), seconds: 5 });
  }, 600);

  // 调试模式：底部表情切换点（body.debug 显示）
  const dots = document.querySelector('.dp-emodots');
  if (dots) {
    for (const k of EMOTION_KEYS) {
      const s = document.createElement('span');
      s.dataset.emo = k;
      s.title = k;
      s.addEventListener('click', () => setEmotion(k, { source: 'user' }));
      dots.appendChild(s);
    }
  }
}

boot();

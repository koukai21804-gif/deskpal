// 默认形象：原创 SVG 绿色圆球（Haro 风格参考，非原图）。renderPet(host, emotion, mode) 单一入口。
// 画布 viewBox 0 0 200 200；球心 (100,104) 半径 78；规格见 docs/02 里程碑 B。

const EMOTION_KEYS = ['normal', 'happy', 'surprised', 'angry', 'thinking', 'sad'];

// ---------- 主体（常量） ----------
const DEFS = `
<defs>
  <radialGradient id="ballGrad" cx="0.38" cy="0.30" r="0.9">
    <stop offset="0" stop-color="#A8DB6B"/>
    <stop offset="0.45" stop-color="#8DC63F"/>
    <stop offset="0.8" stop-color="#6FAE33"/>
    <stop offset="1" stop-color="#5E9B2E"/>
  </radialGradient>
</defs>`;

const BASE = `
<ellipse cx="100" cy="190" rx="52" ry="8" fill="#000" opacity=".12"/>
<circle cx="100" cy="104" r="78" fill="url(#ballGrad)"/>
<g class="dp-seams" stroke="#234D12" stroke-width="2" opacity=".55" fill="none" stroke-linecap="round">
  <path d="M 88 32 L 82 44"/>
  <path d="M 100 28 L 100 42"/>
  <path d="M 112 32 L 118 44"/>
  <path d="M 24 121 Q 100 136 176 121"/>
</g>
<g fill="#234D12" opacity=".55">
  <rect x="90" y="25" width="5" height="2.6" rx="1.3"/>
  <rect x="97.5" y="23" width="5" height="2.6" rx="1.3"/>
  <rect x="105" y="25" width="5" height="2.6" rx="1.3"/>
</g>
<g opacity=".45">
  <ellipse cx="70" cy="58" rx="27" ry="14" fill="#fff" transform="rotate(-24 70 58)"/>
  <ellipse cx="77" cy="65" rx="15" ry="7.5" fill="#fff" transform="rotate(-24 77 65)"/>
</g>`;

// ---------- 眼睛（中心 x≈76.6/123.4, y≈88.4；竖椭圆 1:1.6） ----------
function eyesFor(emotion) {
  switch (emotion) {
    case 'happy': // ^ 形弧线
      return `<g class="dp-eyes" stroke="#B03A3A" stroke-width="3.5" fill="none" stroke-linecap="round">
        <path d="M 64 93 Q 76.6 79 89 93"/>
        <path d="M 111 93 Q 123.4 79 136 93"/>
      </g>`;
    case 'surprised': // 放大圆眼 + 白高光
      return `<g class="dp-eyes">
        <circle cx="76.6" cy="88.4" r="13" fill="#B03A3A" stroke="#8E2F2F" stroke-width="1.5"/>
        <circle cx="123.4" cy="88.4" r="13" fill="#B03A3A" stroke="#8E2F2F" stroke-width="1.5"/>
        <circle cx="72.4" cy="84.4" r="4" fill="#fff"/>
        <circle cx="119.2" cy="84.4" r="4" fill="#fff"/>
      </g>`;
    case 'angry': { // 竖椭圆 + 主体色斜矩形裁出怒目
      const lid = (cx, deg) =>
        `<rect x="${cx - 14}" y="72" width="28" height="17" fill="#8DC63F" transform="rotate(${deg} ${cx} 88.4)"/>`;
      return `<g class="dp-eyes">
        <ellipse cx="76.6" cy="88.4" rx="8" ry="13" fill="#B03A3A" stroke="#8E2F2F" stroke-width="1.5" transform="rotate(5 76.6 88.4)"/>
        <ellipse cx="123.4" cy="88.4" rx="8" ry="13" fill="#B03A3A" stroke="#8E2F2F" stroke-width="1.5" transform="rotate(-5 123.4 88.4)"/>
        ${lid(76.6, 16)}${lid(123.4, -16)}
      </g>`;
    }
    case 'thinking': { // 半垂眼睑（平直盖住上半）+ 一眼上移
      const lid = (cx) => `<rect x="${cx - 13}" y="72" width="26" height="16.5" fill="#8DC63F"/>`;
      return `<g class="dp-eyes">
        <ellipse cx="76.6" cy="88.4" rx="8" ry="13" fill="#B03A3A" stroke="#8E2F2F" stroke-width="1.5" transform="rotate(5 76.6 88.4)"/>
        <ellipse cx="123.4" cy="85.4" rx="8" ry="13" fill="#B03A3A" stroke="#8E2F2F" stroke-width="1.5" transform="rotate(-5 123.4 85.4)"/>
        ${lid(76.6)}${lid(123.4)}
      </g>`;
    }
    case 'sad': { // 半垂眼睑 + 外角下垂
      const lid = (cx, deg) =>
        `<rect x="${cx - 13}" y="72" width="26" height="16" fill="#8DC63F" transform="rotate(${deg} ${cx} 88.4)"/>`;
      return `<g class="dp-eyes">
        <ellipse cx="76.6" cy="88.4" rx="8" ry="12" fill="#B03A3A" stroke="#8E2F2F" stroke-width="1.5" transform="rotate(-6 76.6 88.4)"/>
        <ellipse cx="123.4" cy="88.4" rx="8" ry="12" fill="#B03A3A" stroke="#8E2F2F" stroke-width="1.5" transform="rotate(6 123.4 88.4)"/>
        ${lid(76.6, -14)}${lid(123.4, 14)}
      </g>`;
    }
    default: // normal 竖椭圆，微外倾 ±5°
      return `<g class="dp-eyes">
        <ellipse cx="76.6" cy="88.4" rx="8" ry="13" fill="#B03A3A" stroke="#8E2F2F" stroke-width="1.5" transform="rotate(5 76.6 88.4)"/>
        <ellipse cx="123.4" cy="88.4" rx="8" ry="13" fill="#B03A3A" stroke="#8E2F2F" stroke-width="1.5" transform="rotate(-5 123.4 88.4)"/>
      </g>`;
  }
}

// ---------- 嘴 + 附加元素 ----------
function mouthFor(emotion) {
  switch (emotion) {
    case 'happy':
      return `<g>
        <path d="M 65 121 Q 100 143 135 121 Q 100 162 65 121 Z" fill="#7A2E2E"/>
        <path d="M 65 121 Q 100 143 135 121" fill="none" stroke="#1A1A1A" stroke-width="2.5" stroke-linecap="round"/>
        <ellipse cx="52" cy="108" rx="10" ry="6" fill="#F2A6B0" opacity=".5"/>
        <ellipse cx="148" cy="108" rx="10" ry="6" fill="#F2A6B0" opacity=".5"/>
      </g>`;
    case 'surprised':
      return `<g>
        <ellipse cx="100" cy="128" rx="7" ry="9.5" fill="none" stroke="#1A1A1A" stroke-width="2.5"/>
        <g stroke="#1A1A1A" stroke-width="3" stroke-linecap="round">
          <path d="M 62 13 L 62 23"/><path d="M 138 13 L 138 23"/>
        </g>
      </g>`;
    case 'angry':
      return `<g>
        <path d="M 70 132 Q 100 116 130 132" fill="none" stroke="#1A1A1A" stroke-width="2.5" stroke-linecap="round"/>
        <g stroke="#C0392B" stroke-width="2.5" stroke-linecap="round">
          <path d="M 100 13 L 100 29"/><path d="M 92 20 L 108 20"/>
          <path d="M 94.5 14.5 L 105.5 25.5"/><path d="M 105.5 14.5 L 94.5 25.5"/>
        </g>
      </g>`;
    case 'thinking':
      return `<g>
        <path d="M 88 129 L 112 124" fill="none" stroke="#1A1A1A" stroke-width="2.5" stroke-linecap="round"/>
        <g fill="#234D12" opacity=".5">
          <circle cx="150" cy="42" r="5"/><circle cx="162" cy="30" r="3.5"/><circle cx="171" cy="20" r="2.4"/>
        </g>
      </g>`;
    case 'sad':
      return `<g>
        <path d="M 75 130 Q 87 121 100 130 Q 113 139 125 130" fill="none" stroke="#1A1A1A" stroke-width="2.5" stroke-linecap="round"/>
        <path class="dp-tear" d="M 139 106 C 133 117, 135 125, 139 128 C 143 125, 145 117, 139 106 Z" fill="#6FB7E8" opacity=".85"/>
      </g>`;
    default:
      return `<path d="M 72 123 Q 100 133 128 123" fill="none" stroke="#1A1A1A" stroke-width="2.5" stroke-linecap="round"/>`;
  }
}

// 渲染入口。slot: {mode:'svg'} 或 {mode:'image', file}（自定义差分图）
export function renderPet(host, emotion, slot) {
  if (slot && slot.mode === 'image' && slot.file) {
    const url = 'file:///' + String(slot.file).replace(/\\/g, '/');
    host.innerHTML = `<div class="dp-sprite-img"><img src="${url}" alt="${emotion}" draggable="false"></div>`;
    // 图片缺失/加载失败时回退内置 SVG，避免出现空白占位
    host.querySelector('img').addEventListener('error', () => {
      if (host.isConnected) renderPet(host, emotion, { mode: 'svg' });
    }, { once: true });
    return;
  }
  host.innerHTML = `<svg class="dp-sprite-svg" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
    ${DEFS}${BASE}
    ${eyesFor(emotion)}
    ${mouthFor(emotion)}
    <g class="dp-zzz" fill="#234D12" opacity="0"><text x="150" y="36" font-size="17">Z</text><text x="163" y="22" font-size="13">z</text></g>
  </svg>`;
}

export { EMOTION_KEYS };

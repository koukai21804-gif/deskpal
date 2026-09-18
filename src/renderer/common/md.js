// markdown + KaTeX 渲染封装（防 XSS：先 escapeHtml 再 marked.parse；数学公式占位替换）
const MATH_PLACEHOLDER = '\u0000KTX';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 提取 $$..$$ 与 $..$ → 占位 token，返回 { text, maths }
function extractMath(raw) {
  const maths = [];
  let text = String(raw ?? '');
  // 先块级 $$...$$，再行内 $...$（不匹配 \$ 转义与数字紧邻的 $，如 $5）
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    maths.push({ tex, display: true });
    return `${MATH_PLACEHOLDER}${maths.length - 1}${MATH_PLACEHOLDER}`;
  });
  text = text.replace(/(?<![\w$\\])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g, (_, tex) => {
    maths.push({ tex, display: false });
    return `${MATH_PLACEHOLDER}${maths.length - 1}${MATH_PLACEHOLDER}`;
  });
  return { text, maths };
}

export function renderMD(raw) {
  if (!window.marked) return escapeHtml(raw);
  const { text, maths } = extractMath(raw);
  const escaped = escapeHtml(text);
  let html;
  try {
    html = window.marked.parse(escaped, { mangle: false, headerIds: false, breaks: true });
  } catch (_) {
    return escaped.replace(/\n/g, '<br>');
  }
  // 占位符回填 KaTeX（escapeHtml 不碰 \u0000，安全）
  html = html.replace(new RegExp(`${MATH_PLACEHOLDER}(\\d+)${MATH_PLACEHOLDER}`, 'g'), (_, i) => {
    const m = maths[+i];
    if (!m || !window.katex) return escapeHtml(m ? m.tex : '');
    try {
      return window.katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false });
    } catch (_) {
      return escapeHtml(m.tex);
    }
  });
  return html;
}

// 纯文本首行摘要（消息列表预览用）
export function plainPreview(raw, n = 60) {
  const t = String(raw ?? '').replace(/[#*`>\-\[\]()!]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

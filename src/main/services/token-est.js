// token 估算（全应用统一口径，spec D14）：CJK 字符 ×0.5 + 其他 ×0.25
// chat.js 上下文裁剪与 net-search 回填记账共用，改口径只改这里。
function tokenEstimate(text) {
  const t = String(text || '');
  const cjk = (t.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  return cjk * 0.5 + Math.max(0, t.length - cjk) * 0.25;
}

module.exports = { tokenEstimate };

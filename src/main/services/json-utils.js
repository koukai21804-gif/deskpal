// 从 LLM 输出中抢救 JSON：剥 markdown 代码围栏 → 直接解析 → 截断修复（字符串感知的括号配平）→ 正则兜底
function rescueJSON(text) {
  if (text == null) return null;
  const t = String(text).replace(/```[a-zA-Z]*[ \t]*\n?/g, '').trim();

  // 1. 整体就是 JSON（最常见）
  try { return JSON.parse(t); } catch (_) {}

  const start = t.search(/[[{]/);
  if (start === -1) return null;
  const s = t.slice(start);

  // 字符串感知扫描：找完整顶层闭合点 + 容器内"最后一个完整元素"结束位置（截断修复的最佳切点）
  let inStr = false, esc = false;
  const st = [];
  let safeEnd = -1, complete = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') st.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      st.pop();
      if (st.length === 0) { complete = i; break; }
      if (st.length >= 1 && ch === '}') safeEnd = i;
    }
  }

  // 给前缀补齐未闭合的引号/括号，并清掉悬挂的逗号或 "key":
  const close = (prefix) => {
    let pIn = false, pEsc = false;
    const pst = [];
    for (let i = 0; i < prefix.length; i++) {
      const ch = prefix[i];
      if (pIn) {
        if (pEsc) pEsc = false;
        else if (ch === '\\') pEsc = true;
        else if (ch === '"') pIn = false;
        continue;
      }
      if (ch === '"') { pIn = true; continue; }
      if (ch === '{' || ch === '[') pst.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') pst.pop();
    }
    let out = prefix;
    if (pIn) out += '"';
    out = out.replace(/[\s,]*$/, '').replace(/"(?:[^"\\]|\\.)*"\s*:\s*$/, '').replace(/[\s,]*$/, '');
    return out + pst.reverse().join('');
  };

  const candidates = [];
  if (complete >= 0) candidates.push(s.slice(0, complete + 1));                       // 混文字但顶层完整
  if (safeEnd >= 0) candidates.push(close(s.slice(0, safeEnd + 1)));                  // 截到最后一个完整元素
  candidates.push(close(s));                                                          // 全量配平
  const lastComma = s.lastIndexOf(',');
  if (lastComma > 0) candidates.push(close(s.slice(0, lastComma)));                   // 退到上一个逗号
  // 正则捷径兜底（贪婪，可能只取到内嵌结构，放最后）
  const arr = t.match(/\[[\s\S]*\]/);
  const obj = t.match(/\{[\s\S]*\}/);
  if (obj) candidates.push(obj[0]);
  if (arr) candidates.push(arr[0]);

  for (const c of candidates) {
    try { return JSON.parse(c); } catch (_) {}
  }
  return null;
}

module.exports = { rescueJSON };

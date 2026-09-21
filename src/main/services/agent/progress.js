// [进展:] 流式剥离器：任意 chunk 边界安全切分，半截标记永不泄漏到聊天气泡
// 协议（见 prompts.js 任务执行模式段）：
//   [进展:设计|发现|能力|验证] <≤40 字说明>（单行）
// 容错：同行紧跟下一个标记时各自剥出（说明文字不互相吞噬）。
// 事件分层：llm:chunk 只承载干净正文；剥出的进展行由调用方转 agent:step 结构化推送。
const PHASES = '设计|发现|能力|验证';
// 标记 = 前缀 + 说明文字（非贪婪 ≤60 字，终止于换行 / 下一个标记 / 流尾）
const MARK_RE = new RegExp('\\[进展[:：]\\s*(' + PHASES + ')\\s*\\]\\s*([^\\n]{0,60}?)(?=\\s*\\[进展|\\n|$)');

function createProgressSplitter() {
  let buffer = '';
  let done = false;

  // 内部处理：返回 {cleanDelta, progress, held}；final=true 时（流结束）不再保留尾巴
  function process(final) {
    let clean = '';
    const progress = [];
    while (true) {
      const m = MARK_RE.exec(buffer);
      if (!m) break;
      const start = m.index;
      const end = start + m[0].length;
      if (!final) {
        // 行完整性：说明文字后面既非换行也非下一个标记 → 可能还没写完，等下一 chunk
        const rest = buffer.slice(end);
        if (!/^(\r?\n|\s*\[进展)/.test(rest)) {
          clean += buffer.slice(0, start);
          buffer = buffer.slice(start); // 回滚：连同标记一起等下一 chunk
          return { cleanDelta: clean, progress, held: true };
        }
      }
      clean += buffer.slice(0, start);
      progress.push({ phase: m[1], text: (m[2] || '').replace(/\r+$/, '').trim() });
      buffer = buffer.slice(end); // 只删「标记+说明」段，行内其余正文保留
      // 标记独占一行（其后紧跟换行）时连同换行一起剥除，避免正文残留空行
      const nl = buffer.match(/^\r?\n/);
      if (nl) buffer = buffer.slice(nl[0].length);
    }
    if (final) {
      clean += buffer;
      buffer = '';
      return { cleanDelta: clean, progress, held: false };
    }
    // 尾巴保留：buffer 末尾自最后一个 [ 起无 ] 且长度 <12 → 可能是半截标记，留在 buffer
    const li = buffer.lastIndexOf('[');
    if (li >= 0) {
      const tail = buffer.slice(li);
      if (!tail.includes(']') && tail.length < 12) {
        clean += buffer.slice(0, li);
        buffer = tail;
        return { cleanDelta: clean, progress, held: true };
      }
    }
    clean += buffer;
    buffer = '';
    return { cleanDelta: clean, progress, held: false };
  }

  return {
    feed(chunk) {
      if (done) return { cleanDelta: '', progress: [] };
      buffer += String(chunk);
      return process(false);
    },
    // 流结束：残余 buffer 按正文原样输出（不足标记的尾巴不丢字）
    flush() {
      if (done) return { cleanDelta: '', progress: [] };
      done = true;
      return process(true);
    },
  };
}

module.exports = { createProgressSplitter };

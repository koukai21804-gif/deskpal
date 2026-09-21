// 流式输出管线：进展剥离 → 节拍剥离 → 干净 delta 推 llm:chunk。
// llm:chunk 只承载干净正文；节拍 hint（beat 字段）随正文同帧推送，渲染层在该句
// 显示完成时刻触发宠物表情；[进展:] 行经 onProgress 回调转 agent:step 结构化事件。
// 注：细案写的处理顺序是「节拍 → 进展」，但节拍位置必须落在最终 clean（进展
// 剥离之后）的字符坐标上，否则含进展标记的回复节拍句序会整体偏移。两类语法
// 互不相交、剥离可交换，故此处进展先行，输出 delta 等价、节拍坐标正确。
const emotion = require('./emotion');
const progress = require('./agent/progress');
const windows = require('../windows');

function makeStreamPipeline(tab, reqId, { withProgress = false, onProgress = null } = {}) {
  let beat = emotion.createBeatParser();
  let prog = withProgress ? progress.createProgressSplitter() : null;

  function emit(delta, beatHint) {
    const win = windows.getWindow('chat');
    if (win) { try { win.webContents.send('llm:chunk', { tab, reqId, delta, beat: beatHint }); } catch (_) {} }
  }

  // 假完成重试等场景：整体重置（渲染层同步清空正文）
  function reset() {
    beat = emotion.createBeatParser();
    prog = withProgress ? progress.createProgressSplitter() : null;
  }

  return {
    onDelta(raw) {
      let d = String(raw);
      if (prog) {
        const p = prog.feed(d);
        d = p.cleanDelta;
        for (const item of p.progress) { try { onProgress && onProgress(item); } catch (_) {} }
      }
      const b = beat.feed(d);
      if (b.cleanDelta || b.beatHints.length) emit(b.cleanDelta, b.beatHints[b.beatHints.length - 1]);
    },
    // 流结束：先冲进展剥离器残余，再冲节拍解析器 → {clean, beats, emotion, schedule}
    flush() {
      let progResidual = '';
      if (prog) {
        const p = prog.flush();
        for (const item of p.progress) { try { onProgress && onProgress(item); } catch (_) {} }
        progResidual = p.cleanDelta;
      }
      const bf = beat.feed(progResidual);
      if (bf.cleanDelta || bf.beatHints.length) emit(bf.cleanDelta, bf.beatHints[bf.beatHints.length - 1]);
      const fl = beat.flush();
      if (fl.cleanDelta) emit(fl.cleanDelta, undefined);
      return fl;
    },
    reset,
  };
}

module.exports = { makeStreamPipeline };

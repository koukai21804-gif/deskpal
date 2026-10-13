// zstd 解压（DSH 会话文件 session.jsonl.zstd 需要）：
// 优先 Node 自带（zlib.zstdDecompressSync，Node ≥22.15/23.8；Electron 31 无），
// 兜底 fzstd（纯 JS 解码器，npm 依赖，双端兼容）。两者都不可用时返回 null，调用方降级。
const fs = require('fs');
const zlib = require('zlib');

let impl = null;
try { if (typeof zlib.zstdDecompressSync === 'function') impl = 'zlib'; } catch (_) {}
if (!impl) { try { require.resolve('fzstd'); impl = 'fzstd'; } catch (_) {} }

function available() { return !!impl; }
function implName() { return impl; }

// zstd 魔数 0xFD2FB528（小端字节序 28 B5 2F FD）；多帧文件按帧切开逐帧解压
function splitFrames(buf) {
  const frames = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      // 帧边界搜索：找到下一个魔数位置作为本帧结束的近似（fzstd/zlib 都能容忍尾随无关字节？不能——
      // zlib 单帧解压遇尾随字节会报错，fzstd decompress 会在首个帧尾停。
      // 因此：zlib 路径必须精确切块；这里向前扫描下一个魔数，最后一段到文件尾。
      let j = i + 4;
      let next = buf.length;
      while (j + 4 <= buf.length) {
        if (buf[j] === 0x28 && buf[j + 1] === 0xb5 && buf[j + 2] === 0x2f && buf[j + 3] === 0xfd) { next = j; break; }
        j++;
      }
      frames.push(buf.subarray(i, next));
      i = next;
    } else {
      i++;
    }
  }
  return frames;
}

// 解压整个 Buffer → Buffer；失败返回 null（半写尾帧整体作废，调用方保留已解析前缀）
function decompress(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  try {
    if (impl === 'zlib') {
      const frames = splitFrames(buf);
      const parts = [];
      for (const f of frames) {
        // 单帧内仍可能有坏尾：退化为逐帧尝试，坏帧跳过其后全部（与 token-monitor 的
        // 「坏帧作废其后记录、保留已验证前缀」策略一致——这里按帧粒度保守处理）
        try { parts.push(zlib.zstdDecompressSync(f)); } catch (_) { break; }
      }
      return parts.length ? Buffer.concat(parts) : null;
    }
    if (impl === 'fzstd') {
      const fzstd = require('fzstd');
      const frames = splitFrames(buf);
      const parts = [];
      for (const f of frames) {
        try { parts.push(Buffer.from(fzstd.decompress(f))); } catch (_) { break; }
      }
      return parts.length ? Buffer.concat(parts) : null;
    }
  } catch (_) {}
  return null;
}

// 便捷：读取 .jsonl（可选 .zstd）全文 → string；打不开/解不了返回 null
function readMaybeZstd(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (_) { return null; }
  if (file.endsWith('.zstd') || (buf.length > 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd)) {
    const out = decompress(buf);
    return out ? out.toString('utf8') : null;
  }
  return buf.toString('utf8');
}

module.exports = { available, implName, decompress, readMaybeZstd };

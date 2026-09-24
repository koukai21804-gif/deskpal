// 内置工具：read_file / list_dir / write_file（全部经 fs-guard 仲裁）
// write_file 的用户批准由 loop 的权限闸统一拦截（H1.4）；handler 内 fs-guard 校验保留作双保险。
const guard = require('../fs-guard');
const memory = require('../memory');
const fs = require('fs');
const path = require('path');
const tools = require('./tools');

// read_file 分段读取：大文件单段回填会把上下文撑爆，也可能被结果上限截掉而模型不知情。
// 返回体自带已读区间与续读 offset，与 write_file 的分段追加（append:"true"）对称。
const READ_CHUNK_DEFAULT = 16000;
const READ_CHUNK_MAX = 32000;

tools.register({
  name: 'read_file',
  desc: '读取指定路径的文本文件内容（敏感路径会被拒绝）。大文件分段返回：默认每次 ≤16000 字符；未读完时返回体末尾给出续读 offset，必须继续调用读完全部内容后再下结论',
  params: {
    path: 'string 绝对路径',
    offset: 'string 可选：起始字符位置（0 起）。续读时用上一次返回体提示里给出的 offset',
    length: 'string 可选：本次读取的字符数（≤32000），缺省 16000',
  },
  permission: 'read',
  enabled: true,
  handler: async (args) => {
    const text = String(guard.readFileGuard(args.path, 'utf8'));
    const total = text.length;
    let offset = Math.round(+args.offset);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    if (offset >= total) return `[read_file] ${args.path}｜共 ${total} 字符｜offset ${offset} 已超出文件末尾，无内容返回`;
    let length = Math.round(+args.length);
    if (!Number.isFinite(length) || length <= 0) length = READ_CHUNK_DEFAULT;
    length = Math.min(length, READ_CHUNK_MAX);
    const slice = text.slice(offset, offset + length);
    const end = offset + slice.length;
    const head = `[read_file] ${args.path}｜共 ${total} 字符｜本次返回第 ${offset}–${end} 字符`;
    const tail = end < total
      ? `\n\n【未读完：还剩 ${total - end} 字符。继续读取请再次调用 read_file，参数 {"path":"${args.path}","offset":${end}}；读完全部内容前不要对文件下结论】`
      : '\n【已到文件末尾】';
    return `${head}\n${slice}${tail}`;
  },
});

// save_memory：角色的真实长期记忆写入（写应用记忆库 memory/roleplay，非文件系统，
// 不属于文件权限管辖，任何模式可用）。「记下了/写进长期记忆」的承诺由此真实落地；
// 与自动提取/手动面板共用同一份存储与淘汰规则（上限 50）。
tools.register({
  name: 'save_memory',
  desc: '把值得长期记住的信息写入你的长期记忆。用户明确要求「记住…/写进长期记忆/记一下」时必须实际调用本工具——只在正文里说「记下了」不算数；自己固化关于用户的长期性结论（核心偏好/重要事实）时也可主动调用。宁缺毋滥：只存长期有效的关键信息，不存闲聊细节',
  params: {
    content: 'string 记忆内容（≤60字，一条只写一个要点）',
    importance: 'string 可选：重要性 1-5，默认 3（5=核心偏好/身份事实，1=琐碎）',
    type: 'string 可选：fact/preference/event/relationship，默认 fact',
  },
  permission: 'read',
  enabled: true,
  handler: async (args) => {
    const item = memory.addMemory({ content: args.content, importance: args.importance, type: args.type });
    return `已写入长期记忆（${item.type}｜重要性${item.importance}）：${item.content}`;
  },
});

// 各工具回填给模型的结果上限（字符），loop 侧 jstr 按工具名取用。
// read_file 段内自截且带续读标记，上限放宽到能容纳满段；其余工具保持保护性 4000。
tools.RESULT_CAPS = { read_file: 40000 };

tools.register({
  name: 'list_dir',
  desc: '列出目录内容（名称/是否目录/大小）',
  params: { path: 'string 目录绝对路径' },
  permission: 'read',
  enabled: true,
  handler: async (args) => {
    return guard.listDirGuard(args.path);
  },
});

tools.register({
  name: 'write_file',
  desc: '写文件（可写范围由当前权限模式决定：可编辑=应用数据目录内；完全编辑=本机大部分目录，每次写入需用户批准）。大文件必须分段写入：先写第一段，之后各段用 append="true" 追加，否则输出可能被 token 上限截断',
  params: {
    path: 'string 目标绝对路径',
    content: 'string 完整文件内容（整体覆盖写入）',
    reason: 'string 必填，≤60字，向用户说明为什么要写这个文件',
    append: 'string 可选："true" 时把 content 追加到文件末尾（大文件分段写入用）；缺省为整体覆盖',
  },
  permission: 'write',
  enabled: true,
  handler: async (args) => {
    if (!args.reason || !String(args.reason).trim()) {
      throw new Error('write_file 必须提供 reason 参数（向用户说明写入原因）');
    }
    if (!guard.canWrite(args.path)) throw new Error('写入被拒绝：目标不在当前权限模式允许的范围内');
    const contentStr = String(args.content ?? '');
    fs.mkdirSync(path.dirname(args.path), { recursive: true });
    if (args.append === true || String(args.append).toLowerCase() === 'true') {
      fs.appendFileSync(args.path, contentStr, 'utf8');
      let total = 0;
      try { total = fs.statSync(args.path).size; } catch (_) {}
      return `已追加 ${Buffer.byteLength(contentStr, 'utf8')} 字节到 ${args.path}（文件现共 ${total} 字节）`;
    }
    fs.writeFileSync(args.path, contentStr, 'utf8');
    return '已写入 ' + args.path + '（' + Buffer.byteLength(contentStr, 'utf8') + ' 字节）';
  },
});

module.exports = tools;

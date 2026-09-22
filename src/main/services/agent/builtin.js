// 内置工具：read_file / list_dir / write_file（全部经 fs-guard 仲裁）
// write_file 的用户批准由 loop 的权限闸统一拦截（H1.4）；handler 内 fs-guard 校验保留作双保险。
const guard = require('../fs-guard');
const fs = require('fs');
const path = require('path');
const tools = require('./tools');

tools.register({
  name: 'read_file',
  desc: '读取指定路径的文本文件内容（敏感路径会被拒绝）',
  params: { path: 'string 绝对路径' },
  permission: 'read',
  enabled: true,
  handler: async (args) => {
    return guard.readFileGuard(args.path, 'utf8');
  },
});

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

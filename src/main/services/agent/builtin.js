// 内置工具：read_file / list_dir 只读启用；write_file 仅 userData 白名单且禁用态注册
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
  desc: '写文件（仅允许写入 userData 及其 temp 子目录，当前禁用）',
  params: { path: 'string 目标绝对路径', content: 'string 内容' },
  permission: 'write',
  enabled: false, // ★Agent 写能力预留，本次不启用
  handler: async (args) => {
    if (!guard.canWrite(args.path)) throw new Error('写入被拒绝：目标不在允许的目录内');
    fs.mkdirSync(path.dirname(args.path), { recursive: true });
    fs.writeFileSync(args.path, String(args.content ?? ''), 'utf8');
    return 'ok';
  },
});

module.exports = tools;

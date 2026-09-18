// Agent 工具注册表（F8 预留）：本次只读工具不接入聊天；写工具以禁用态注册
// 后续开发 Agent 能力时：启用 write 工具 + 在 chat 管线接入 tool-call loop 即可
const registry = new Map(); // name -> {name, desc, params, permission, enabled, handler}

function register(tool) {
  registry.set(tool.name, tool);
}

function get(name) {
  return registry.get(name) || null;
}

function list() {
  return [...registry.values()].map(t => ({
    name: t.name, desc: t.desc, params: t.params, permission: t.permission, enabled: !!t.enabled,
  }));
}

// 执行入口（供未来 Agent loop 调用）：禁用/越权直接拒绝
async function invoke(name, args, ctx = {}) {
  const t = registry.get(name);
  if (!t) throw new Error('未知工具: ' + name);
  if (!t.enabled) throw new Error(`工具「${name}」当前处于禁用状态`);
  return t.handler(args || {}, ctx);
}

module.exports = { register, get, list, invoke };

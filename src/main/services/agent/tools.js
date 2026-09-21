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

// 启用工具 → OpenAI function calling schema（params 描述格式 "string 说明" → JSON Schema）
function openAiSchemas() {
  return [...registry.values()].filter(t => t.enabled).map(t => {
    const properties = {}, required = [];
    for (const [key, desc] of Object.entries(t.params || {})) {
      const m = String(desc || '').match(/^\s*(\w+)\s*(.*)$/);
      const type = m && m[1] === 'string' ? 'string' : 'string';
      properties[key] = { type, description: (m && m[2] || '').trim() || (key === 'reason' ? '必填：向用户说明本次写入的原因（≤60字）' : key) };
      if (key === 'reason' || key === 'path' || key === 'content') required.push(key);
    }
    return {
      type: 'function',
      function: { name: t.name, description: t.desc, parameters: { type: 'object', properties, required } },
    };
  });
}

// 执行入口（供未来 Agent loop 调用）：禁用/越权直接拒绝
async function invoke(name, args, ctx = {}) {
  const t = registry.get(name);
  if (!t) throw new Error('未知工具: ' + name);
  if (!t.enabled) throw new Error(`工具「${name}」当前处于禁用状态`);
  return t.handler(args || {}, ctx);
}

module.exports = { register, get, list, openAiSchemas, invoke };

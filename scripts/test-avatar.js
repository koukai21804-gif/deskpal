// 用户头像 + look_user_avatar 回归（纯 Node，不需要 Electron 运行时）
// 覆盖：魔数校验 / 体积上限 / 落盘与状态 / 聊天窗读取入口 / 重置清理 / 工具注册与视觉闸
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function throws(fn, re, name) {
  try { fn(); ok(false, name + '（未抛错）'); }
  catch (e) { ok(re.test(e.userMsg || e.message || ''), name + `（实际：${e.userMsg || e.message}）`); }
}
async function throwsAsync(fn, re, name) {
  try { await fn(); ok(false, name + '（未抛错）'); }
  catch (e) { ok(re.test(e.userMsg || e.message || ''), name + `（实际：${e.userMsg || e.message}）`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-avatar-'));
process.env.DESKPAL_TEST = '1';

const store = require(path.join(ROOT, 'src/main/services/store'));
store.init(tmp);
const avatars = require(path.join(ROOT, 'src/main/services/avatars'));
const tools = require(path.join(ROOT, 'src/main/services/agent/tools'));
const llm = require(path.join(ROOT, 'src/main/services/llm'));
require(path.join(ROOT, 'src/main/services/agent/builtin'));

console.log('\n## 初始状态与校验');
ok(avatars.state().user === null, '未上传时 state.user 为 null');
throws(() => avatars.setUserFromBuffer(Buffer.from('not an image at all')), /不是可识别的图片/, '非图片内容被拒');
throws(() => avatars.setUserFromBuffer(Buffer.alloc(avatars.MAX_BYTES + 1)), /超过 8MB/, '超过 8MB 被拒');
ok(avatars.readUserImage() === null, '未上传时 readUserImage 为 null');

console.log('\n## 上传与落盘');
const fixture = fs.readFileSync(path.join(ROOT, 'icon.png'));
const st = avatars.setUserFromBuffer(fixture);
ok(!!st.user, '上传后 state.user 存在');
ok(st.user.file === 'user/avatar.png', '固定落盘到 user/avatar.png');
ok(fs.existsSync(st.user.path), '头像文件真实写入数据目录');
ok(st.user.width === 1254 && st.user.height === 1254, '记录像素尺寸 1254×1254');
ok(st.user.mime === 'image/png', 'MIME 按魔数判定为 png');
ok(store.get('avatar').user.file === 'user/avatar.png', '配置里只存相对路径（数据目录可迁移）');
store.flushAll();
ok(fs.existsSync(path.join(tmp, 'config', 'avatar.json')), 'config/avatar.json 已落盘');

console.log('\n## 助手头像');
const stA = avatars.setAssistantFromBuffer(fixture);
ok(!!stA.assistant, '上传后 state.assistant 存在');
ok(stA.assistant.file === 'user/assistant-avatar.png', '固定落盘到 user/assistant-avatar.png');
ok(fs.existsSync(stA.assistant.path), '助手头像文件真实写入数据目录');
ok(stA.user && stA.user.file === 'user/avatar.png', '上传助手头像不影响用户头像');
ok(avatars.readUserImage().file === 'user/avatar.png', '助手头像不占用用户头像读取入口');

console.log('\n## 聊天窗 / 视觉读取入口');
const img = avatars.readUserImage();
ok(!!img && img.buf.length > 0, 'readUserImage 返回图像字节');
ok(img && img.mime === 'image/png' && img.file === 'user/avatar.png', 'readUserImage 元信息正确');

console.log('\n## look_user_avatar 工具');
const tool = tools.get('look_user_avatar');
ok(!!tool && tool.enabled, '工具已注册且启用');
ok(!!tool && tool.permission === 'read', '权限级别为 read');
ok(tools.openAiSchemas().some(s => s.function.name === 'look_user_avatar'), '无参数工具也能生成 schema');

const realVision = llm.isVisionCapable;
llm.isVisionCapable = () => true;
(async () => {
  const r = await tools.invoke('look_user_avatar', {}, {});
  ok(!!r.imagePart && r.imagePart.type === 'image_url', '有头像时返回 image_url 图像部分');
  ok(String(r.imagePart.image_url.url).startsWith('data:image/png;base64,'), '图像以 data URL 注入');
  ok(r.meta && r.meta.tool === 'look_user_avatar', 'meta.tool 标记正确（压缩侧按工具名分类）');

  llm.isVisionCapable = () => false;
  await throwsAsync(() => tools.invoke('look_user_avatar', {}, {}), /未开启图像识别/, '无视觉能力时兜底拒绝');

  llm.isVisionCapable = () => true;
  avatars.resetUser();
  await throwsAsync(() => tools.invoke('look_user_avatar', {}, {}), /尚未上传头像/, '重置后调用如实报错');
  ok(!!avatars.state().assistant, '重置用户头像不影响助手头像');
  llm.isVisionCapable = realVision;

  console.log('\n## 重置');
  const st2 = avatars.state();
  ok(st2.user === null, '重置后 state.user 为 null');
  ok(!fs.existsSync(path.join(tmp, 'user', 'avatar.png')), '重置删除头像文件');
  ok(avatars.readUserImage() === null, '重置后 readUserImage 为 null');

  const st3 = avatars.resetAssistant();
  ok(st3.assistant === null, '重置助手头像后 state.assistant 为 null');
  ok(!fs.existsSync(path.join(tmp, 'user', 'assistant-avatar.png')), '重置删除助手头像文件');
  ok(avatars.state().user === null, '助手重置不复活用户头像');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n========== 头像测试: ${passed} 通过, ${failed} 失败 ==========`);
  process.exit(failed ? 1 : 0);
})();

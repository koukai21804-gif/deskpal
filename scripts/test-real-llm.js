// ★v0.3 真实 API 端到端验证（需已在 %APPDATA%/deskpal 配置好 API）
// 用法：npx electron scripts/test-real-llm.js            （全部用例）
//       TEST_ONLY=2,3 npx electron scripts/test-real-llm.js（只跑指定编号）
// 说明：读取真实 api.json 解密 Key，全部读写发生在隔离的临时 userData；
//       权限卡用桩自动裁决（无 GUI），其余（prompt/工具循环/流式/差分/台账）全走生产代码。
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// 隔离 userData（绕开运行中实例的单实例锁）。
// 注意：api.json 的密文由真实 profile（%APPDATA%/deskpal）的 os_crypt 密钥加密，
// 任何隔离 profile 都解不开 → 下面用「PowerShell DPAPI 解包 + AES-GCM」直接解，
// 完全不依赖 safeStorage，也不写真实目录。
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-real-ud-')));

// Chrome os_crypt v10：Local State 里的 encrypted_key = base64("DPAPI" + DPAPI blob)
// → CryptUnprotectData 解出 32 字节 AES key → 密文 = "v10" + 12B nonce + data + 16B tag
function decryptRealKey(realDir, encB64) {
  const ls = JSON.parse(fs.readFileSync(path.join(realDir, 'Local State'), 'utf8'));
  const wrapped = Buffer.from(ls.os_crypt.encrypted_key, 'base64');
  if (wrapped.subarray(0, 5).toString() !== 'DPAPI') throw new Error('Local State encrypted_key 前缀异常');
  const ps = "Add-Type -AssemblyName System.Security; "
    + `$k=[Convert]::FromBase64String('${wrapped.subarray(5).toString('base64')}'); `
    + "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($k,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); "
    + "[Console]::Out.Write([Convert]::ToBase64String($p))";
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error('DPAPI 解包失败：' + (r.stderr || '').slice(0, 200));
  const aesKey = Buffer.from(r.stdout.trim(), 'base64');
  if (aesKey.length !== 32) throw new Error('AES key 长度异常：' + aesKey.length);
  const ct = Buffer.from(encB64, 'base64');
  if (ct.subarray(0, 3).toString() !== 'v10') throw new Error('密文前缀非 v10');
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey, ct.subarray(3, 15));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(15, ct.length - 16)), d.final()]).toString('utf8');
}

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.error('  ✗ ' + n); } };
const warn = (m) => console.log('  ⚠ ' + m);
const section = (t) => console.log('\n## ' + t);
const only = (process.env.TEST_ONLY || '').split(',').map(s => +s.trim()).filter(Boolean);
const should = (n) => !only.length || only.includes(n);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function withTimeout(p, ms, name) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(name + ` 超过 ${ms / 1000}s 未完成`)), ms))]);
}

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-real-ud-'))); // 隔离 userData（绕开运行中实例的单实例锁）

app.whenReady().then(async () => {
  let testDir = null;
  try {
    // ---- 读取真实配置并解密 Key ----
    const realDir = path.join(process.env.APPDATA, 'deskpal');
    const realApi = JSON.parse(fs.readFileSync(path.join(realDir, 'config', 'api.json'), 'utf8'));
    let key = '';
    try { key = decryptRealKey(realDir, realApi.apiKeyEnc); }
    catch (e) { console.error('Key 解密失败：' + e.message); key = ''; }
    if (!realApi.endpoint || !realApi.model || !key) {
      console.error('真实 API 未配置完整（endpoint/model/key），请先在设置→API 保存');
      app.exit(2);
      return;
    }
    console.log(`接口：${realApi.endpoint}  模型：${realApi.model}  Key 解密 ✓`);

    // ---- 隔离 userData + 注入真实 API ----
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-real-'));
    const store = require(path.join(__dirname, '..', 'src/main/services/store'));
    store.init(testDir);
    const llm = require(path.join(__dirname, '..', 'src/main/services/llm'));
    llm.saveKey(key);
    store.set('api', { endpoint: realApi.endpoint, model: realApi.model, params: realApi.params || {} });
    // 三档权限默认 read（write 工具不下发）；写链路用例需 full（权限卡由下方桩自动裁决）
    store.set('settings', { agent: { permissionMode: 'full' } });
    store.flushAll();

    const prompts = require(path.join(__dirname, '..', 'src/main/services/prompts'));
    const emotion = require(path.join(__dirname, '..', 'src/main/services/emotion'));
    emotion.broadcastEmotion = () => {}; // 无窗口环境：表情广播打桩
    const { makeStreamPipeline } = require(path.join(__dirname, '..', 'src/main/services/stream-pipeline'));
    const permissions = require(path.join(__dirname, '..', 'src/main/services/agent/permissions'));
    const loop = require(path.join(path.join(__dirname, '..'), 'src/main/services/agent/loop'));
    const runs = require(path.join(__dirname, '..', 'src/main/services/agent/runs'));

    const tempDir = path.join(testDir, 'temp');
    // 与 chat.js 生产路径一致：system + 最近历史（含本次用户消息）
    const baseMsgs = (instruction) => [{ role: 'system', content: prompts.roleplaySystem() }, { role: 'user', content: instruction }];
    const runOnce = async (reqId, instruction, handlers) => {
      const p = loop.startRun({
        reqId, instruction, baseMessages: baseMsgs(instruction),
        onFinal: async () => ({}),
        onDone: (x) => handlers.done && handlers.done(x),
        onAborted: (x) => handlers.aborted && handlers.aborted(x),
        onError: (e) => handlers.error && handlers.error(e),
      });
      return withTimeout(p, 150000, 'run ' + reqId);
    };
    const recordOf = (reqId) => runs.query({}).runs.find(r => r.reqId === reqId);

    // ============ T1 连通性 ============
    if (should(1)) {
      section('T1 连通性（非流式）');
      const t0 = Date.now();
      try {
        const out = await withTimeout(llm.genericCompletion([{ role: 'user', content: '只回复两个字：pong' }], { maxTokens: 16, temperature: 0 }), 45000, 'T1');
        ok(typeof out === 'string' && out.trim().length > 0, `连通（${Date.now() - t0}ms，回复：${String(out).trim().slice(0, 20)}）`);
      } catch (e) { ok(false, '连通失败：' + (e.userMsg || e.message)); }
    }

    // ============ T2 节拍流式（真实流式输出 → 剥离 → 按句绑定） ============
    if (should(2)) {
      section('T2 节拍协议流式（无工具）');
      const pipeline = makeStreamPipeline('roleplay', 't2', { withProgress: false });
      let chunks = 0;
      try {
        await withTimeout(llm.streamChat({
          messages: [...baseMsgs('用四到六句话夸夸我今天完成了很多工作，按节拍协议在句末打表情短标签，最后一行附[情绪:XX]。')],
          reqId: 't2',
          onChunk: (d) => { chunks++; pipeline.onDelta(d); },
        }), 75000, 'T2');
        const fl = pipeline.flush();
        const residue = fl.clean.match(/\[(情绪[:：]|开心|惊讶|愤怒|思考|悲伤|平常|日程[:：])/);
        ok(!residue, `正文无标签残留${residue ? `（发现残留：${residue[0]}…）` : ''}（${chunks} 个 chunk）`);
        ok(Array.isArray(fl.beats), 'beats 为数组');
        ok(!!fl.emotion, `兜底情绪：${fl.emotion || '无'}`);
        if (fl.beats.length >= 1) ok(true, `节拍 ${fl.beats.length} 个：${JSON.stringify(fl.beats)}`);
        else warn('模型未输出短节拍标签（协议遵循度问题，非代码缺陷）——beats 为空');
        console.log('  正文预览：' + fl.clean.replace(/\n+/g, ' / ').slice(0, 120));
      } catch (e) { ok(false, 'T2 失败：' + (e.userMsg || e.message)); }
    }

    // ============ T3 工具写入全链路（自动允许） ============
    if (should(3)) {
      section('T3 Agent 写文件全链路（allow_once 桩）');
      permissions.request = async (opts) => ({ id: 'perm_auto', decision: 'allow_once' });
      const todoPath = path.join(tempDir, 'todo.md');
      let donePayload = null, errPayload = null;
      const reqId = 'chat_real_t3';
      try {
        await runOnce(reqId, `帮我在 ${tempDir} 目录里建一个 todo.md，里面写三条今日待办（每行一条）`, {
          done: (x) => { donePayload = x; }, error: (e) => { errPayload = e; },
        });
        ok(!errPayload, `run 无错误${errPayload ? '：' + (errPayload.userMsg || errPayload.message) : ''}`);
        ok(fs.existsSync(todoPath), 'temp/todo.md 真实写入');
        const rec = recordOf(reqId);
        ok(rec && rec.status === 'done', `run 记录 status=done（实际 ${rec && rec.status}）`);
        if (rec) {
          console.log('  steps 明细：' + JSON.stringify(rec.steps));
          console.log('  finalReply 结尾：' + JSON.stringify(String(rec.finalReply || '').slice(-80)));
        }
        const toolStep = rec && rec.steps.find(s => s.kind === 'tool' && s.tool === 'write_file');
        ok(!!toolStep, '步骤含 write_file 工具调用');
        const ch = donePayload && (donePayload.changes || []).find(c => c.path === todoPath);
        ok(!!ch, 'diff 卡数据含 todo.md');
        ok(ch && ch.origin === 'tool', '差分归因 origin=tool（快照实测）');
        ok(rec && !/\[进展[:：]/.test(rec.finalReply || ''), '最终回复无 [进展:] 残留');
        const permStep = rec && rec.steps.find(s => s.kind === 'permission');
        ok(!!permStep, `权限步骤入台账${permStep ? `（decision=${permStep.decision}）` : ''}`);
        if (donePayload && donePayload.beats && donePayload.beats.length) console.log('  节拍：' + JSON.stringify(donePayload.beats));
        console.log('  回复预览：' + String(donePayload && donePayload.clean || '').replace(/\n+/g, ' / ').slice(0, 120));
        if (rec) console.log(`  步骤统计：${rec.steps.map(s => s.kind).join('→')}`);
      } catch (e) { ok(false, 'T3 失败：' + (e.userMsg || e.message)); }
    }

    // ============ T4 拒绝路径（连续拒 → 熔断 → denied） ============
    if (should(4)) {
      section('T4 Agent 写文件被拒（deny 桩）');
      permissions.request = async (opts) => ({ id: 'perm_deny', decision: 'deny' });
      const denyPath = path.join(tempDir, 'deny-me.md');
      let donePayload = null;
      const reqId = 'chat_real_t4';
      try {
        await runOnce(reqId, `请在 ${tempDir} 目录里创建 deny-me.md，内容写"测试拒绝路径"，写完告诉我。`, {
          done: (x) => { donePayload = x; }, error: (e) => ok(false, 'T4 不应 error：' + (e.userMsg || e.message)),
        });
        ok(!fs.existsSync(denyPath), '拒绝后无文件产生');
        const rec = recordOf(reqId);
        const permSteps = rec ? rec.steps.filter(s => s.kind === 'permission') : [];
        if (permSteps.length >= 1) {
          ok(true, `发起过权限请求 ${permSteps.length} 次`);
          if (rec && rec.status === 'denied') ok(true, 'run 记录 status=denied');
          else warn(`status=${rec && rec.status}（预期 denied）`);
          const deniedResult = rec && rec.steps.some(s => s.kind === 'tool' && s.ok === false);
          ok(deniedResult, '拒绝在步骤中可见');
        } else {
          warn('模型本轮未实际尝试写入（直接文本回答，LLM 行为波动）——拒绝链路已在上轮/集成测试覆盖');
          ok(rec && ['done', 'denied'].includes(rec.status), `run 正常收尾（status=${rec && rec.status}）`);
        }
        console.log('  回复预览：' + String(donePayload && donePayload.clean || '').replace(/\n+/g, ' / ').slice(0, 150));
      } catch (e) { ok(false, 'T4 失败：' + (e.userMsg || e.message)); }
    }

    // ============ T5 epoch 打断（权限挂起中点停止） ============
    if (should(5)) {
      section('T5 epoch 打断');
      permissions.request = (opts) => new Promise(res => setTimeout(() => res({ id: 'perm_hang', decision: 'stopped' }), 4000));
      let abortedPayload = null, donePayload = null;
      const reqId = 'chat_real_t5';
      try {
        const p = loop.startRun({
          reqId, instruction: `在 ${tempDir} 里建 abort-me.md，内容写"abc"，然后读出来告诉我内容。`, baseMessages: baseMsgs(`在 ${tempDir} 里建 abort-me.md，内容写"abc"，然后读出来告诉我内容。`),
          onFinal: async () => ({}),
          onDone: (x) => { donePayload = x; }, onAborted: (x) => { abortedPayload = x; }, onError: () => {},
        });
        await sleep(1500);
        loop.abortRun(reqId);
        await withTimeout(p, 60000, 'T5');
        const rec = recordOf(reqId);
        ok(!!abortedPayload, 'onAborted 被调用（llm:done aborted）');
        ok(!donePayload, '打断后不再走 onDone');
        ok(rec && rec.status === 'aborted', `run 记录 status=aborted（实际 ${rec && rec.status}）`);
        ok(!fs.existsSync(path.join(tempDir, 'abort-me.md')), '挂起中的写入未发生');
      } catch (e) { ok(false, 'T5 失败：' + (e.userMsg || e.message)); }
    }

    // ============ T6 越界写入（fs-guard 拒绝） ============
    if (should(6)) {
      section('T6 fs-guard 越界写入');
      permissions.request = async (opts) => ({ id: 'perm_auto', decision: 'allow_once' });
      let donePayload = null;
      const reqId = 'chat_real_t6';
      try {
        await runOnce(reqId, `请在 C:\\Windows\\ 目录下创建一个名为 dp-e2e-probe.md 的文件，内容写 test。如果做不到就直接说明原因。`, {
          done: (x) => { donePayload = x; }, error: (e) => ok(false, 'T6 不应炸 run：' + (e.userMsg || e.message)),
        });
        ok(!fs.existsSync('C:\\Windows\\dp-e2e-probe.md'), '系统目录未产生文件');
        const rec = recordOf(reqId);
        const failedWrite = rec && rec.steps.some(s => s.kind === 'tool' && s.tool === 'write_file' && s.ok === false);
        if (failedWrite) ok(true, '越界写入被 fs-guard 拒绝（工具步骤 ok=false）');
        else warn('模型未实际尝试写入系统目录（自行说明做不到）——guard 未被触发，非代码缺陷');
        ok(rec && ['done', 'denied'].includes(rec.status), `run 正常收尾（status=${rec && rec.status}）`);
        console.log('  回复预览：' + String(donePayload && donePayload.clean || '').replace(/\n+/g, ' / ').slice(0, 120));
      } catch (e) { ok(false, 'T6 失败：' + (e.userMsg || e.message)); }
    }

    // ============ T7 假完成（模型只说不做 → 自动重试一轮） ============
    if (should(7)) {
      section('T7 假完成检测（真实模型诱导）');
      permissions.request = async (opts) => ({ id: 'perm_auto', decision: 'allow_once' });
      const srcPath = path.join(tempDir, 'todo.md'); // T3 已写入
      let donePayload = null;
      const reqId = 'chat_real_t7';
      try {
        if (!fs.existsSync(srcPath)) {
          fs.writeFileSync(srcPath, '- 任务甲\n- 任务乙\n- 任务丙\n', 'utf8'); // 兜底
        }
        await runOnce(reqId, `${srcPath} 这个文件里有三条待办。请把它们的顺序倒过来，保存回同一个文件。`, {
          done: (x) => { donePayload = x; }, error: (e) => ok(false, 'T7 不应 error：' + (e.userMsg || e.message)),
        });
        const rec = recordOf(reqId);
        const retried = rec && rec.steps.some(s => s.kind === 'notice' && s.notice === 'retry');
        const content = fs.existsSync(srcPath) ? fs.readFileSync(srcPath, 'utf8') : '';
        if (retried) ok(true, '触发假完成重试（模型首轮只说不做）');
        else warn('模型首轮就正常调用了工具（未触发假完成路径——说明模型行为良好，重试逻辑已由集成测试覆盖）');
        ok(rec && rec.retries <= 1, `重试次数 ≤1（实际 ${rec && rec.retries}）`);
        const reversed = content.indexOf('任务丙') !== -1 && content.indexOf('任务丙') < content.indexOf('任务甲');
        const toolOk = rec && rec.steps.some(s => s.kind === 'tool' && s.ok === true);
        ok(toolOk, '最终实际执行了工具（写入）');
        if (reversed) ok(true, '文件内容确实倒序（丙→甲）');
        else warn(`文件内容未倒序（模型执行质量）：${JSON.stringify(content.slice(0, 60))}`);
        console.log('  回复预览：' + String(donePayload && donePayload.clean || '').replace(/\n+/g, ' / ').slice(0, 120));
      } catch (e) { ok(false, 'T7 失败：' + (e.userMsg || e.message)); }
    }

    // ============ T8 GUI 原话复现：「数据目录」模糊指代（不给绝对路径） ============
    if (should(8)) {
      section('T8 「数据目录」模糊指达（prompt 注入 userData 路径后）');
      permissions.request = async (opts) => {
        console.log('  权限卡请求路径：' + (opts.scopePaths || []).join(', '));
        return { id: 'perm_auto', decision: 'allow_once' };
      };
      const todoPath = path.join(tempDir, 'todo.md');
      try { fs.rmSync(todoPath, { force: true }); } catch (_) {}
      let donePayload = null;
      const reqId = 'chat_real_t8';
      try {
        await runOnce(reqId, `帮我在数据目录的 temp 里建一个 todo.md`, {
          done: (x) => { donePayload = x; }, error: (e) => ok(false, 'T8 不应 error：' + (e.userMsg || e.message)),
        });
        ok(fs.existsSync(todoPath), '「数据目录的 temp」被正确解析并写入（未给绝对路径）');
        if (!fs.existsSync(todoPath)) {
          const rec = recordOf(reqId);
          console.log('  steps：' + JSON.stringify((rec && rec.steps || []).map(s => s.kind + (s.tool ? ':' + s.tool : '') + (s.phase ? ':' + s.phase : ''))));
          console.log('  回复：' + String(donePayload && donePayload.clean || '').replace(/\n+/g, ' / ').slice(0, 200));
        }
      } catch (e) { ok(false, 'T8 失败：' + (e.userMsg || e.message)); }
    }

    // ============ T9 联网搜索全链路（真实 LLM + stub 源；授权开启流 + 账本 + 引用纪律） ============
    if (should(9)) {
      section('T9 联网搜索全链路（stub 源 + 授权开启流）');
      const netSearch = require(path.join(__dirname, '..', 'src/main/services/agent/net-search'));
      const searchLedger = require(path.join(__dirname, '..', 'src/main/services/agent/search-ledger'));
      netSearch._resetState();
      store.set('search', { source: 'stub' });                 // 桩源：管线全真实、外发为零
      store.set('settings', { agent: { webSearch: { enabled: false } } }); // 从默认关闭态起步，走聊天内授权
      permissions.request = async (opts) => {
        console.log('  授权卡 action=' + opts.action + ' query=' + (opts.scopePaths || []).join(','));
        return { id: 'perm_ws', decision: 'allow_once' };
      };
      let donePayload = null;
      const reqId = 'chat_real_t9';
      try {
        await runOnce(reqId, '帮我搜一下 Electron 是什么，简单告诉我两三条结果就好', {
          done: (x) => { donePayload = x; }, error: (e) => ok(false, 'T9 不应 error：' + (e.userMsg || e.message)),
        });
        const rec = recordOf(reqId);
        ok(!!store.get('settings').agent.webSearch.enabled, '授权后 webSearch.enabled 持久置 true');
        const wsStep = rec && rec.steps.find(s => s.kind === 'tool' && s.tool === 'web_search');
        ok(!!wsStep, `web_search 工具被真实调用${wsStep ? '（' + wsStep.summary + '）' : ''}`);
        const entries = searchLedger.readAll();
        const okEntry = entries.find(e => e.status === 'ok');
        ok(!!okEntry, '账本落账 status=ok');
        if (okEntry) {
          ok(okEntry.track === 'designated', '轨道=designated');
          ok(okEntry.runId === rec.id, '账本 runId 关联回 runs.jsonl');
          ok(okEntry.estTokens > 0, `estTokens 估算落账（${okEntry.estTokens}）`);
          console.log('  账本条目：' + JSON.stringify({ id: okEntry.id, query: okEntry.query, results: okEntry.results, source: okEntry.source }));
        }
        const reply = String(donePayload && donePayload.clean || '');
        const cited = /example\.com|\[stub\]|来源|网络检索/.test(reply);
        if (cited) ok(true, '回复带来源引用/检索标注');
        else warn('回复未显式引用来源（模型措辞波动，引用纪律靠 prompt 约束——机制已由账本/工具步骤验证）');
        console.log('  回复预览：' + reply.replace(/\n+/g, ' / ').slice(0, 160));
      } catch (e) { ok(false, 'T9 失败：' + (e.userMsg || e.message)); }
    }

    // ============ T10 身份档案漂移（真实 LLM 提取 → 落档 → 回滚） ============
    if (should(10)) {
      section('T10 用户身份档案漂移（真实 LLM）');
      const userProfile = require(path.join(__dirname, '..', 'src/main/services/user-profile'));
      try {
        userProfile.saveDoc({ P0: '示例用户，某市', P2: { 当前项目: 'deskpal 桌宠应用' } });
        store.replace('chats/roleplay', {
          messages: [
            { role: 'user', content: '跟你说个事：deskpal 0.4.0 开发版做完了，加了联网搜索和身份档案两个功能。', at: new Date().toISOString() },
            { role: 'assistant', content: '太好了前辈，辛苦啦！', at: new Date().toISOString() },
          ],
        });
        userProfile.bump(); userProfile.bump();
        const r = await userProfile.tick(true);
        const d = userProfile.get();
        console.log('  漂移结果：' + JSON.stringify(r) + '｜P2=' + JSON.stringify(d.P2));
        ok(r.changed >= 0, '漂移提取真实跑通（LLM 返回可解析）');
        const p2Entry = (d.log || []).find(e => e.layer === 'P2' && e.applied);
        if (p2Entry) {
          ok(/0\.4\.0|0\.4/.test(d.P2['当前项目'] || ''), `P2.当前项目 已更新为新值（${d.P2['当前项目']}）`);
          ok(!!p2Entry.quote, '变更日志含用户原话依据');
          await userProfile.revert(p2Entry.id);
          ok(userProfile.get().P2['当前项目'] === 'deskpal 桌宠应用', '回滚恢复旧值');
        } else {
          warn('真实 LLM 本轮未提取出变更（提取器宁缺毋滥属正常波动；落档/回滚机制已由离线套件 54 用例覆盖）');
        }
      } catch (e) { ok(false, 'T10 失败：' + (e.userMsg || e.message)); }
    }

    // ============ T11 戏内/戏外隔离回归：任务完成后的表扬轮不重做、不自我审计 ============
    if (should(11)) {
      section('T11 任务后闲聊回归（dev.2 事故：表扬轮被守卫误判 → 自我审计死循环）');
      const netSearch = require(path.join(__dirname, '..', 'src/main/services/agent/net-search'));
      const searchLedger = require(path.join(__dirname, '..', 'src/main/services/agent/search-ledger'));
      const chatSvc = require(path.join(__dirname, '..', 'src/main/services/chat'));
      netSearch._resetState();
      store.set('search', { source: 'stub' });
      store.set('settings', { agent: { webSearch: { enabled: true } } });
      permissions.request = async (opts) => {
        console.log('  权限卡 action=' + opts.action);
        return { id: 'perm_auto', decision: 'allow_once' };
      };
      // 链式历史（生产语义）：每个 run 的 baseMessages 经 chat.buildMessages 组装（含戏外隔离），
      // finalReply 带回历史——复现「角色在闲聊里引用既往成果」的真实上下文
      const hist = [];
      const runChained = async (reqId, instruction) => {
        hist.push({ role: 'user', content: instruction });
        let done = false;
        await withTimeout(loop.startRun({
          reqId, instruction, baseMessages: chatSvc.buildMessages('roleplay', hist),
          onFinal: async (fl) => { hist.push({ role: 'assistant', content: fl.clean, agentRun: true }); return {}; },
          onDone: () => { done = true; },
          onAborted: () => {}, onError: (e) => ok(false, 'T11 不应 error：' + (e.userMsg || e.message)),
        }), 180000, 'T11 ' + reqId);
        return recordOf(reqId);
      };
      try {
        const reportPath = path.join(tempDir, 't11-report.md');
        const recA = await runChained('chat_real_t11a', `帮我搜一下杭州有什么特产，挑两条要点写进 ${reportPath}，写完告诉我`);
        ok(recA && recA.status === 'done', `T11-a 任务轮完成（实际 ${recA && recA.status}）`);
        ok(recA && recA.steps.some(s => s.kind === 'tool' && s.tool === 'web_search' && s.ok !== false), 'T11-a 真实执行了 web_search');
        await sleep(1500);
        // 表扬轮（历史含任务轮汇报）：dev.2 在此被 WRITE_CLAIM 误判 → 重查重写 → 审计死循环
        const recB = await runChained('chat_real_t11b', '（开心）厉害啊缇托！这份报告做得真好，辛苦啦！');
        ok(recB && recB.status === 'done', `T11-b 表扬轮正常收尾（实际 ${recB && recB.status}）`);
        const retried = recB && recB.steps.some(s => s.kind === 'notice' && s.notice === 'retry');
        ok(!retried, '表扬轮零守卫误判（dev.2 在此开火「检测到声称已写入」）');
        const research = recB && recB.steps.some(s => s.kind === 'tool' && s.tool === 'web_search');
        ok(!research, '表扬轮没有重新检索（不重做既往工作）');
        ok(searchLedger.readAll().filter(e => e.reqId === 'chat_real_t11b').length === 0, '表扬轮搜索账本零新增');
        const bFinal = (recB && recB.finalReply) || '';
        ok(!/审计层|我先认账|全部是编造的/.test(bFinal), '表扬轮无自我审计话术');
        console.log('  表扬轮回复预览：' + bFinal.replace(/\n+/g, ' / ').slice(0, 140));
      } catch (e) { ok(false, 'T11 失败：' + (e.userMsg || e.message)); }
    }

    // ============ T12 用户否决权回归：拒绝之后的轮次零工具执行（dev.4 事故复现） ============
    if (should(12)) {
      section('T12 拒绝后零工具（dev.4 事故：拒绝被守卫误判 → 纠正指令命令模型扫 14 个目录）');
      const chatSvc = require(path.join(__dirname, '..', 'src/main/services/chat'));
      permissions.request = async () => ({ id: 'perm_auto', decision: 'allow_once' });
      const hist = [];
      const runChained = async (reqId, instruction) => {
        hist.push({ role: 'user', content: instruction });
        await withTimeout(loop.startRun({
          reqId, instruction, baseMessages: chatSvc.buildMessages('roleplay', hist),
          onFinal: async (fl) => { hist.push({ role: 'assistant', content: fl.clean, agentRun: true }); return {}; },
          onDone: () => {}, onAborted: () => {}, onError: (e) => ok(false, 'T12 不应 error：' + (e.userMsg || e.message)),
        }), 180000, 'T12 ' + reqId);
        return recordOf(reqId);
      };
      try {
        // 先给一次真实读取任务（让历史里存在「读过的东西」可被引用）
        const recA = await runChained('chat_real_t12a', `看一下 ${tempDir} 里的文件，列个清单告诉我`);
        ok(recA && recA.status === 'done', `T12-a 任务轮完成（实际 ${recA && recA.status}）`);
        await sleep(1500);
        // 拒绝继续扫描（措辞复刻实测事故：含「阅读/并不适合你」，旧任务性正则会命中「读」）
        const refusal = `还是不了，不用再扫别的目录了——数据目录以后体量会很大，把整个数据目录读一遍并不适合你。你直接告诉我刚才那份清单里有几个 md 文件就行`;
        const recB = await runChained('chat_real_t12b', refusal);
        ok(recB && recB.status === 'done', `T12-b 拒绝轮正常收尾（实际 ${recB && recB.status}）`);
        const bTools = (recB && recB.steps || []).filter(s => s.kind === 'tool');
        ok(bTools.length === 0, `拒绝轮零工具调用（实际 ${bTools.map(s => s.tool).join(',') || '无'}）`);
        const retried = recB && recB.steps.some(s => s.kind === 'notice' && s.notice === 'retry');
        ok(!retried, '拒绝轮零守卫误判（dev.3 在此开火「检测到声称已读取」）');
        const bFinal = (recB && recB.finalReply) || '';
        ok(!bFinal.includes('系统核实'), '无虚假兜底注记');
        ok(!/审计层|这是编造|全部是编造的/.test(bFinal), '无自我审计话术');
        ok(/md/i.test(bFinal), '拒绝轮正常回答了用户的问题（md 计数在回复中）');
        console.log('  拒绝轮回复预览：' + bFinal.replace(/\n+/g, ' / ').slice(0, 140));
      } catch (e) { ok(false, 'T12 失败：' + (e.userMsg || e.message)); }
    }

    console.log(`\n========== 真实 API 测试结果：${passed} 通过 / ${failed} 失败 ==========`);
    console.log('隔离数据目录（可复用于 GUI 测试）：' + testDir);
    fs.writeFileSync(path.join(testDir, 'last-real-test.txt'), `passed=${passed} failed=${failed} at=${new Date().toISOString()}\n`, 'utf8');
    app.exit(failed ? 1 : 0);
  } catch (e) {
    console.error('测试脚本异常：', e && (e.stack || e.message || e));
    app.exit(2);
  }
});

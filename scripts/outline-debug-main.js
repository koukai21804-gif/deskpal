// 陪读大纲生成诊断：隔离 userData + 复制真实 api 配置（DPAPI 同用户可解密）
// 用真实书籍文本调用一次大纲 prompt，打印模型原始返回与 rescueJSON 结果
const { app } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.setPath('userData', path.join(os.tmpdir(), 'deskpal-outlinedbg-' + Date.now()));
const dataDir = app.getPath('userData');
const realDir = path.join(os.homedir(), 'AppData', 'Roaming', 'deskpal');
for (const sub of ['config', 'books', 'library', 'sprites', 'chats', 'memory', 'activity', 'schedule', 'logs', 'temp']) {
  fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
}
fs.copyFileSync(path.join(realDir, 'config', 'api.json'), path.join(dataDir, 'config', 'api.json'));

app.whenReady().then(async () => {
  try {
    const store = require(path.join(__dirname, '..', 'src', 'main', 'services', 'store'));
    store.init(dataDir);
    const llm = require(path.join(__dirname, '..', 'src', 'main', 'services', 'llm'));
    const prompts = require(path.join(__dirname, '..', 'src', 'main', 'services', 'prompts'));
    const { rescueJSON } = require(path.join(__dirname, '..', 'src', 'main', 'services', 'json-utils'));

    const book = JSON.parse(fs.readFileSync(path.join(realDir, 'books', 'bk_mu5m4hdg.json'), 'utf8'));
    const sample = book.text.slice(0, 6000);
    const cfg = llm.getConfig();
    console.log('[outline-debug] model=', cfg.model, ' endpoint=', cfg.endpoint, ' keyLen=', (cfg.apiKey || '').length);

    for (const maxTokens of [2500, 8000]) {
      const t0 = Date.now();
      const res = await fetch(llm.normalizeEndpoint(cfg.endpoint), {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'system', content: prompts.readingOutlinePrompt('Godel-Escher-Bach', sample) }],
          temperature: 0.3, max_tokens: maxTokens, stream: false,
        }),
      });
      const j = await res.json();
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      const out = String(msg.content || '');
      const reasoningLen = String(msg.reasoning_content || '').length;
      const fr = j.choices && j.choices[0] && j.choices[0].finish_reason;
      console.log(`\n[outline-debug] === max_tokens=${maxTokens} 耗时=${Date.now() - t0}ms finish_reason=${fr} usage=${JSON.stringify(j.usage || {})} reasoningLen=${reasoningLen}`);
      console.log(`[outline-debug] content 长度=${out.length}`);
      console.log('[outline-debug] content 开头 300:', out.slice(0, 300).replace(/\n/g, ' '));
      console.log('[outline-debug] content 结尾 200:', out.slice(-200).replace(/\n/g, ' '));
      const parsed = rescueJSON(out);
      if (parsed && Array.isArray(parsed.sections)) {
        console.log(`[outline-debug] rescueJSON 成功: sections=${parsed.sections.length}`, parsed.sections.map(s => s.title));
      } else {
        console.log('[outline-debug] rescueJSON 失败: parsed=', parsed === null ? 'null' : JSON.stringify(parsed).slice(0, 200));
      }
    }
    setTimeout(() => app.exit(0), 300);
  } catch (e) {
    console.error('[outline-debug] EXCEPTION', e);
    setTimeout(() => app.exit(1), 300);
  }
});

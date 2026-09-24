// read_file 分段读取回归：对任意文本文件两段读完必须无损覆盖全文（修复「角色读文档被截断」）
// 用法：node scripts/test-readfile-chunks.js <文件路径>
const fs = require('fs');
const tools = require('../src/main/services/agent/builtin');

(async () => {
  const p = process.argv[2] || 'C:/Users/kokai/Downloads/toh-debate-chat_mucwoimb-2026-09-22.txt';
  const full = fs.readFileSync(p, 'utf8');
  const total = full.length;

  const r1 = await tools.invoke('read_file', { path: p });
  const body1 = r1.slice(r1.indexOf('\n') + 1);
  const unfinishedTail = '\n\n【未读完：还剩 ' + (total - 16000) + ' 字符。继续读取请再次调用 read_file，参数 {"path":"' + p + '","offset":16000}；读完全部内容前不要对文件下结论】';
  const ok1 = body1 === full.slice(0, 16000) + unfinishedTail;
  console.log('段1（默认参数）体=原文[0,16000)+续读标记:', ok1, '| 回填JSON长度:', JSON.stringify(r1).length, '<= 上限', tools.RESULT_CAPS.read_file);

  const r2 = await tools.invoke('read_file', { path: p, offset: 16000 });
  const body2 = r2.slice(r2.indexOf('\n') + 1);
  const doneTail = '\n【已到文件末尾】';
  const ok2 = body2 === full.slice(16000) + doneTail;
  console.log('段2（offset=16000）体=原文[16000,' + total + ')+完结标记:', ok2);

  const jmax = JSON.stringify(await tools.invoke('read_file', { path: p, offset: 0, length: 32000 })).length;
  console.log('满段 32000 字符回填 JSON 长度:', jmax, '<= 上限:', jmax <= tools.RESULT_CAPS.read_file);

  console.log('边界:超尾offset →', await tools.invoke('read_file', { path: p, offset: total + 5 }));
  console.log('边界:非法offset/length →', (await tools.invoke('read_file', { path: p, offset: 'x', length: 'y' })).split('\n')[0]);

  if (!ok1 || !ok2) { console.error('FAILED'); process.exit(1); }
  console.log('PASSED');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

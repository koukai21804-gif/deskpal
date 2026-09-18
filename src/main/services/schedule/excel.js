// 日程：Excel 项目表 → 任务列表（exceljs 读取 + LLM 拆解 + 本地校验）
const dayjs = require('dayjs');
const ExcelJS = require('exceljs');
const llm = require('../llm');
const prompts = require('../prompts');
const { rescueJSON } = require('../json-utils');
const { materializeReminders, newEvent } = require('./scheduler');

// 读首个（或行数最多的）工作表 → { sheetNames, cols, rows }
async function parseExcel(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  if (!wb.worksheets.length) throw friendlyError('Excel 里没有工作表');
  let ws = wb.worksheets[0];
  for (const w of wb.worksheets) if (w.rowCount > ws.rowCount) ws = w;

  const cellText = (c) => {
    if (c == null || c.value == null) return '';
    if (c.value instanceof Date) return dayjs(c.value).format('YYYY-MM-DD HH:mm');
    if (typeof c.value === 'object') {
      if (c.value.text) return String(c.value.text);
      if (c.value.result != null) return String(c.value.result);
      if (c.value.richText) return c.value.richText.map(r => r.text).join('');
      return '';
    }
    return String(c.value);
  };

  // 找表头行：前 5 行中非空单元格最多的一行
  let headerRow = 1;
  let maxNonEmpty = -1;
  for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
    const row = ws.getRow(r);
    let n = 0;
    for (let c = 1; c <= 10; c++) if (cellText(row.getCell(c)).trim()) n++;
    if (n > maxNonEmpty) { maxNonEmpty = n; headerRow = r; }
  }

  const cols = [];
  const hr = ws.getRow(headerRow);
  for (let c = 1; c <= 8; c++) cols.push(cellText(hr.getCell(c)).trim() || `列${c}`);

  const rows = [];
  for (let r = headerRow + 1; r <= Math.min(headerRow + 200, ws.rowCount) && rows.length < 200; r++) {
    const row = ws.getRow(r);
    const vals = [];
    let any = false;
    for (let c = 1; c <= 8; c++) {
      const v = cellText(row.getCell(c)).trim().slice(0, 50);
      if (v) any = true;
      vals.push(v);
    }
    if (any) rows.push(vals);
  }
  if (!rows.length) throw friendlyError('表格里没有数据行');
  return {
    sheetNames: wb.worksheets.map(w => w.name),
    cols, rows,
  };
}

function friendlyError(msg) { const e = new Error(msg); e.userMsg = msg; return e; }

// LLM 拆解 → 可编辑预览任务列表
async function decompose({ cols, rows }) {
  const rowsText = [cols.join(' | '), ...rows.map(r => r.join(' | '))].join('\n').slice(0, 12000);
  const res = await llm.genericCompletion(
    [{ role: 'system', content: prompts.scheduleDecomposePrompt(rowsText) }],
    { temperature: 0.1, maxTokens: 3000 },
  );
  const j = rescueJSON(res);
  if (!j || !Array.isArray(j.tasks)) return { tasks: [] };

  const tasks = [];
  for (const t of j.tasks.slice(0, 30)) {
    const start = t.expectedStart ? dayjs(t.expectedStart, 'YYYY-MM-DD HH:mm', true) : null;
    const deadline = t.deadline ? dayjs(t.deadline, 'YYYY-MM-DD HH:mm', true) : null;
    const invalid = (start && (!start.isValid() || start.isBefore(dayjs().subtract(1, 'minute'))))
      || (deadline && (!deadline.isValid() || deadline.isBefore(dayjs().subtract(1, 'minute'))));
    tasks.push({
      title: String(t.title || '').slice(0, 24),
      notes: String(t.notes || '').slice(0, 60),
      start: start && start.isValid() ? start : null,
      deadline: deadline && deadline.isValid() ? deadline : null,
      remindPreset: ['start', 'deadline', 'none'].includes(t.remindPreset)
        ? t.remindPreset : (deadline ? 'deadline' : start ? 'start' : 'none'),
      valid: !invalid && String(t.title || '').trim(),
    });
  }
  return { tasks };
}

// 预览确认后的批量导入（同组 groupId）
function buildImportDraft(tasks, groupId) {
  return tasks.filter(t => t.valid).map(t => {
    const ev = newEvent({
      kind: 'task',
      title: t.title, notes: t.notes,
      start: t.start, deadline: t.deadline,
      durationMin: null, remindPreset: t.remindPreset, source: 'excel',
    });
    ev.groupId = groupId;
    materializeReminders(ev);
    return ev;
  });
}

module.exports = { parseExcel, decompose, buildImportDraft };

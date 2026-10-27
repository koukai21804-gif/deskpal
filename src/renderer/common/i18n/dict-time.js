// en 词典（时间统计窗 time/app.js）。key=中文原文（动态串带 {0} 占位）。
// 类别名/应用名是存储数据，保持原样不翻。
(function (g) {
  g.DP_I18N_EN = Object.assign(g.DP_I18N_EN || {}, {
    'deskpal · 时间统计': 'deskpal · Time stats',
    '标注未知应用': 'Label unknown apps',
    'AI 时间报告': 'AI time report',
    '▶ 恢复监测': '▶ Resume tracking', '⏸ 暂停监测': '⏸ Pause tracking',
    '{0}电脑使用': '{0} computer usage',
    '最常用类别 {0}': 'Top category {0}',
    '使用过的应用': 'Apps used',
    '离开时间（空闲）': 'Away time (idle)',
    '有 <b>{0}</b> 个应用还不知道是什么类型，标注后统计更准确': '<b>{0}</b> app(s) still have no category — labeling them makes stats more accurate',
    '去标注': 'Label now',
    '⏰ 24 小时分布': '⏰ 24-hour distribution',
    '类别占比（共 {0}）': 'Category share ({0} total)',
    '还没有分类数据（先标注未知应用吧）': 'No category data yet (label unknown apps first)',
    '应用排行': 'App ranking',
    '未标注': 'Unlabeled',
    '今天还没有使用记录': 'No usage recorded today',
    '停止': 'Stop',
    '已恢复时间监测': 'Time tracking resumed', '已暂停时间监测': 'Time tracking paused',
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);

/**
 * TDM.exporter - 结果导出：txt 与 CSV（UTF-8 with BOM）
 *
 * 规则（plan.md 契约）：
 *  - downloadTxt(filenamePrefix, title, sections)：分组标题 + 条目可读文本
 *  - downloadCsv(filenamePrefix, rows)：首列分组，列 = 分组,名称,类型,来源分区,完整路径
 *  - downloadMergedTxt(filenamePrefix, sideLabel, partitions)：多 txt 合并为单文件下载
 *  - 文件名 = 前缀_YYYYMMDD-HHmmss.txt / .csv（前缀中的非法文件名字符会被替换）
 *  - 两者均带 UTF-8 BOM（\uFEFF），CSV 供 Excel 直接打开无乱码
 *  - 通过 Blob + <a download> 触发下载（file:// 协议下可用）
 */
(function () {
  'use strict';

  const TDM = (window.TDM = window.TDM || {});
  const exporter = (TDM.exporter = TDM.exporter || {});

  /**
   * 生成时间戳：YYYYMMDD-HHmmss（本地时间）
   * @returns {string}
   */
  function timestamp() {
    const d = new Date();
    const p = function (n) { return String(n).padStart(2, '0'); };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
      + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /**
   * 清理文件名前缀中的非法字符（Windows 不允许 \/:*?"<>|），并限制长度
   * @param {string} prefix
   * @returns {string}
   */
  function sanitizePrefix(prefix) {
    const cleaned = String(prefix || '导出').replace(/[\\/:*?"<>|]/g, '_').trim();
    return cleaned.length > 0 ? cleaned.slice(0, 40) : '导出';
  }

  /**
   * 通过临时 <a download> 触发浏览器下载
   * @param {Blob} blob
   * @param {string} filename
   */
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 释放 objectURL（延后以兼容下载启动时序）
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /**
   * 条目类型中文标签
   * @param {object} entry
   * @returns {string}
   */
  function typeLabel(entry) {
    return entry.type === 'file' ? '文件' : '文件夹';
  }

  /**
   * 导出 txt：分组标题 + 可读条目文本
   * @param {string} filenamePrefix 文件名前缀
   * @param {string} title 文件内标题行
   * @param {{ heading: string, rows: object[] }[]} sections 分组
   */
  function downloadTxt(filenamePrefix, title, sections) {
    const lines = [];
    lines.push('===== ' + title + ' =====');
    lines.push('导出时间：' + new Date().toLocaleString('zh-CN'));
    lines.push('');

    const list = sections || [];
    for (let i = 0; i < list.length; i++) {
      const section = list[i];
      const rows = section.rows || [];
      lines.push('【' + section.heading + '】共 ' + rows.length + ' 条');
      for (let j = 0; j < rows.length; j++) {
        const e = rows[j];
        lines.push('  [' + typeLabel(e) + '] ' + e.name);
        lines.push('        路径：' + e.path);
        lines.push('        来源分区：' + e.partition);
      }
      lines.push('');
    }

    // UTF-8 with BOM；txt 使用 CRLF 提升记事本兼容性
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
    triggerDownload(blob, sanitizePrefix(filenamePrefix) + '_' + timestamp() + '.txt');
  }

  /**
   * CSV 字段转义：含逗号/引号/换行时用引号包裹，内部引号翻倍
   * @param {*} value
   * @returns {string}
   */
  function csvEscape(value) {
    const s = String(value);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * 导出 CSV：UTF-8 with BOM，列 = 分组,名称,类型,来源分区,完整路径
   * @param {string} filenamePrefix 文件名前缀
   * @param {{ group: string, entry: object }[]} rows 行数据
   */
  function downloadCsv(filenamePrefix, rows) {
    const lines = ['分组,名称,类型,来源分区,完整路径'];
    const list = rows || [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const e = item.entry;
      lines.push([
        item.group,
        e.name,
        typeLabel(e),
        e.partition,
        e.path,
      ].map(csvEscape).join(','));
    }

    // UTF-8 with BOM，Excel 直接打开中文无乱码
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, sanitizePrefix(filenamePrefix) + '_' + timestamp() + '.csv');
  }

  /**
   * 合并下载：把一侧全部原始 txt 以标记行分隔合并为单个 txt。
   * 每个分区前写入 "TDM-MERGE-SOURCE: <原始文件名>" 标记，重新上传时
   * 解析器据此拆分还原各分区（硬盘）归属。
   * @param {string} filenamePrefix 文件名前缀
   * @param {string} sideLabel 侧名称（写入文件头说明）
   * @param {{ fileName: string, rawText: string }[]} partitions 该侧全部分区
   */
  function downloadMergedTxt(filenamePrefix, sideLabel, partitions) {
    const list = partitions || [];
    const parts = [];
    parts.push('========== TDM 合并文件（' + sideLabel + '）==========');
    parts.push('合并时间：' + new Date().toLocaleString('zh-CN'));
    parts.push('分区数量：' + list.length);
    parts.push('说明：本文件由 Tree 数据库匹配系统合并生成，可直接整体重新上传，系统将按标记自动还原各分区（硬盘）归属。');
    parts.push('');
    for (let i = 0; i < list.length; i++) {
      parts.push('========== TDM-MERGE-SOURCE: ' + String(list[i].fileName || '') + ' ==========');
      // 原始文本统一 CRLF 并去掉尾部空白，避免分区间堆积多余空行
      const raw = String(list[i].rawText || '').replace(/\r\n|\r|\n/g, '\r\n').replace(/\s+$/, '');
      if (raw.length > 0) parts.push(raw);
      parts.push('');
    }
    // 与其他导出一致：UTF-8 with BOM，CRLF 换行
    const blob = new Blob(['\uFEFF' + parts.join('\r\n')], { type: 'text/plain;charset=utf-8' });
    triggerDownload(blob, sanitizePrefix(filenamePrefix) + '_' + timestamp() + '.txt');
  }

  /* ---------- 挂载 ---------- */
  exporter.downloadTxt = downloadTxt;
  exporter.downloadCsv = downloadCsv;
  exporter.downloadMergedTxt = downloadMergedTxt;
})();

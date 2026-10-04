/**
 * TDM.ui - DOM 渲染层：上传统计、提示、忙碌遮罩、虚拟目录浏览
 *
 * 设计约定：
 *  - 所有动态插入的名称/路径文本一律先经 escapeHtml 转义（防 XSS）
 *  - 渲染函数只负责把数据画到 DOM；事件绑定统一在 main.js 装配
 */
(function () {
  'use strict';

  const TDM = (window.TDM = window.TDM || {});
  const ui = (TDM.ui = TDM.ui || {});

  /* ---------- 基础工具 ---------- */

  /** 按 id 取元素 */
  function $(id) {
    return document.getElementById(id);
  }

  /** HTML 转义（防 XSS） */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 千分位格式化 */
  function fmt(n) {
    return Number(n).toLocaleString('zh-CN');
  }

  /* ---------- Toast 提示 ---------- */

  /**
   * 全局轻提示
   * @param {string} message 文案
   * @param {'info' | 'error'} kind 类型
   */
  function toast(message, kind) {
    const container = $('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (kind === 'error' ? 'toast-error' : 'toast-info');
    el.textContent = message; // textContent 天然免疫 XSS
    container.appendChild(el);
    // 3.2 秒后淡出并移除
    setTimeout(function () {
      el.classList.add('fade-out');
      setTimeout(function () { el.remove(); }, 300);
    }, 3200);
  }

  /* ---------- 忙碌遮罩 ---------- */

  /**
   * 全局忙碌态开关
   * @param {boolean} processing 是否处理中
   * @param {string} [text] 遮罩文案（可选）
   */
  function setBusy(processing, text) {
    const overlay = $('busy-overlay');
    if (!overlay) return;
    if (typeof text === 'string' && text.length > 0) {
      const t = $('busy-text');
      if (t) t.textContent = text;
    }
    overlay.hidden = !processing;
  }

  /* ---------- 上传侧统计渲染 ---------- */

  const SIDE_LABELS = { mobile: '移动数据库', remote: '异地数据库' };

  /**
   * 渲染某一侧的汇总统计与分区清单
   * @param {'mobile' | 'remote'} sideKey
   * @param {object | null} stats SideStats；null 表示该侧无数据（占位态）
   */
  function renderSideStats(sideKey, stats) {
    const summaryEl = $('summary-' + sideKey);
    const listEl = $('partitions-' + sideKey);
    if (!summaryEl || !listEl) return;

    // 无数据：占位显示
    if (!stats) {
      summaryEl.textContent = '尚未上传数据';
      summaryEl.classList.add('placeholder');
      listEl.innerHTML = '';
      listEl.hidden = true;
      return;
    }

    // 汇总行
    summaryEl.classList.remove('placeholder');
    let summaryText = '已上传 ' + stats.partitionCount + ' 个分区 · '
      + fmt(stats.folderCount) + ' 个文件夹 · '
      + fmt(stats.fileCount) + ' 个文件';
    if (stats.invalidFiles.length > 0) {
      summaryText += ' · ' + stats.invalidFiles.length + ' 个文件未解析出有效条目';
    }
    summaryEl.textContent = summaryText;

    // 分区清单（每分区文件名 + 条目数；无效文件红色标记）
    const partitions = TDM.core.getPartitions(sideKey);
    let html = '';
    for (let i = 0; i < partitions.length; i++) {
      const p = partitions[i];
      const invalid = !p.hasValidContent;
      const total = p.folderCount + p.fileCount;
      // 来源硬盘标注：单盘分区显示盘符根路径，多盘（拼接文件）显示硬盘数
      let rootLabel = '';
      if (p.roots && p.roots.length === 1) rootLabel = p.roots[0] + ' · ';
      else if (p.roots && p.roots.length > 1) rootLabel = p.roots.length + ' 个硬盘 · ';
      const right = invalid ? '未解析出有效条目' : rootLabel + fmt(total) + ' 条';
      html += '<li class="partition-item' + (invalid ? ' invalid' : '') + '">'
        + '<span class="p-name" title="' + escapeHtml(p.fileName) + '">' + escapeHtml(p.fileName) + '</span>'
        + '<span class="p-count">' + right + '</span>'
        + '</li>';
    }
    listEl.innerHTML = html;
    listEl.hidden = partitions.length === 0;
  }

  /* ---------- 功能入口状态 ---------- */

  /**
   * 依据当前数据状态更新各功能入口的可用性：
   *  - 清空按钮：该侧已有数据才可用
   *  - 合并下载按钮：该侧存在任意分区（含无效分区）即可用
   *  - 差异分析按钮：两侧均含有效条目才可用
   */
  function updateFunctionStates() {
    const ready = TDM.core.isReady();

    const btnClearMobile = $('btn-clear-mobile');
    const btnClearRemote = $('btn-clear-remote');
    if (btnClearMobile) btnClearMobile.disabled = !ready.mobile;
    if (btnClearRemote) btnClearRemote.disabled = !ready.remote;

    const btnMergeMobile = $('btn-merge-mobile');
    const btnMergeRemote = $('btn-merge-remote');
    if (btnMergeMobile) btnMergeMobile.disabled = TDM.core.getPartitions('mobile').length === 0;
    if (btnMergeRemote) btnMergeRemote.disabled = TDM.core.getPartitions('remote').length === 0;

    const btnDiff = $('btn-diff');
    if (btnDiff) btnDiff.disabled = !(ready.mobile && ready.remote);
  }

  /**
   * 差异结果过期提示：已有差异结果且被标记 stale 时显示提示条
   */
  function updateStaleTip() {
    const tip = $('diff-stale-tip');
    if (!tip) return;
    const diff = TDM.core.getDiff();
    tip.hidden = !(diff !== null && diff.stale);
  }

  /**
   * 数据变更（上传/清空）后由 main 调用：统一刷新功能入口状态与过期提示，
   * 并使虚拟目录浏览复位（浏览位置随旧数据失效）
   * @param {'mobile' | 'remote'} [_sideKey] 变更侧（当前无需区分，保留参数）
   */
  function notifyDataChanged(_sideKey) {
    updateFunctionStates();
    updateStaleTip();
    treeReset();
  }

  /* ============================================================
   * 行内图标（查找 / 差异 / 虚拟目录共用）
   * ============================================================ */

  // 各类别图标的 SVG 内容（24×24 线性描边，与主题切换按钮同风格；
  // stroke currentColor，具体颜色由 .entry-icon.ic-* 类控制）
  const ENTRY_ICONS = {
    disk: '<line x1="22" y1="12" x2="2" y2="12"/>'
      + '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'
      + '<line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
    audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/>'
      + '<polyline points="21 15 16 10 5 21"/>',
    archive: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/>'
      + '<line x1="10" y1="12" x2="14" y2="12"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
      + '<polyline points="14 2 14 8 20 8"/>'
  };

  // 扩展名 → 图标类别（未知扩展名回退 file）
  const FILE_ICON_EXTS = {
    video: 'mp4 mkv avi mov wmv flv webm m4v mpg mpeg rm rmvb ts m2ts vob 3gp ogv',
    audio: 'mp3 flac wav ape aac ogg wma m4a mid midi opus aiff aif',
    image: 'jpg jpeg png gif bmp webp svg ico tif tiff heic psd',
    archive: 'zip rar 7z tar gz bz2 xz z iso cab jar'
  };
  const EXT_ICON_KINDS = (function () {
    const map = {};
    for (const kind in FILE_ICON_EXTS) {
      const exts = FILE_ICON_EXTS[kind].split(' ');
      for (let i = 0; i < exts.length; i++) map[exts[i]] = kind;
    }
    return map;
  })();

  /**
   * 按文件名扩展名归类图标类别
   * @param {string} name 文件名
   * @returns {'video' | 'audio' | 'image' | 'archive' | 'file'} 类别
   */
  function fileIconKind(name) {
    const dot = name.lastIndexOf('.');
    if (dot < 0 || dot === name.length - 1) return 'file';
    const ext = name.slice(dot + 1).toLowerCase();
    return EXT_ICON_KINDS[ext] || 'file';
  }

  /**
   * 生成条目行内图标（未知类别回退通用文件图标）
   * @param {'disk' | 'folder' | 'video' | 'audio' | 'image' | 'archive' | 'file'} kind
   * @returns {string} SVG HTML 片段
   */
  function entryIconHtml(kind) {
    const k = ENTRY_ICONS[kind] ? kind : 'file';
    return '<svg class="entry-icon ic-' + k + '" viewBox="0 0 24 24" fill="none"'
      + ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + ENTRY_ICONS[k] + '</svg>';
  }

  /* ============================================================
   * 模糊查找结果渲染（含分页 / 类型筛选 / 关键词高亮）
   * ============================================================ */

  const PAGE_SIZE = 50; // 每页条目数（查找与差异共用）

  // 查找页签的内存状态：当前结果、类型筛选与各分组页码
  const searchState = {
    results: null,                        // 最近一次 SearchResults（类型筛选前全量）
    typeFilter: 'all',                    // 'all' | 'file' | 'folder'
    filtered: null,                       // 当前类型筛选结果缓存（避免翻页重复重算）
    page: { mobile: 1, remote: 1 },       // 各分组当前页码
  };
  let searchDelegateBound = false;

  /**
   * 名称高亮：转义后对第一处命中子串加 <mark>。
   * 查找顺序：先在原始名称上定位（小写比对），再分段转义，杜绝 XSS。
   * @param {string} name 原始名称
   * @param {string} kwLower 已归一化（小写）的关键词
   * @returns {string} HTML 片段
   */
  function highlightName(name, kwLower) {
    if (!kwLower) return escapeHtml(name);
    const idx = name.toLowerCase().indexOf(kwLower);
    if (idx < 0) return escapeHtml(name);
    const end = idx + kwLower.length;
    return escapeHtml(name.slice(0, idx))
      + '<mark>' + escapeHtml(name.slice(idx, end)) + '</mark>'
      + escapeHtml(name.slice(end));
  }

  /**
   * 构造单条结果行 HTML（图标/名称/类型徽章/来源分区 + 完整路径，查找与差异共用）。
   * 行携带定位信息（data-side/partition/path/type），点击可在虚拟目录中打开所在文件夹。
   * @param {object} entry Entry
   * @param {string} [kwLower] 归一化关键词（差异分组不传则不高亮）
   * @param {string} [sideKey] 所属数据库侧（虚拟目录跳转用）
   */
  function buildEntryRowHtml(entry, kwLower, sideKey) {
    const isFile = entry.type === 'file';
    return '<div class="result-row"'
      + ' data-side="' + escapeHtml(sideKey || '') + '"'
      + ' data-partition="' + escapeHtml(entry.partition) + '"'
      + ' data-path="' + escapeHtml(entry.path) + '"'
      + ' data-type="' + entry.type + '"'
      + ' title="点击在虚拟目录中打开所在文件夹">'
      + '<div class="result-main">'
      + entryIconHtml(isFile ? fileIconKind(entry.name) : 'folder')
      + '<span class="result-name" title="' + escapeHtml(entry.name) + '">'
      + highlightName(entry.name, kwLower || '') + '</span>'
      + '<span class="badge ' + (isFile ? 'badge-file' : 'badge-folder') + '">'
      + (isFile ? '文件' : '文件夹') + '</span>'
      + '<span class="result-partition" title="' + escapeHtml(entry.partition) + '">'
      + escapeHtml(entry.partition) + '</span>'
      + '</div>'
      + '<div class="result-path" title="' + escapeHtml(entry.path) + '">'
      + escapeHtml(entry.path) + '</div>'
      + '</div>';
  }

  /**
   * 构造分页控件 HTML（data-search-page 供事件委托识别）
   * @param {string} sideKey 分组标识
   * @param {number} total 总条数
   * @param {number} page 当前页（1 起）
   */
  function buildPaginationHtml(sideKey, total, page) {
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    function btn(label, target, disabled) {
      return '<button type="button" class="page-btn" data-side="' + sideKey
        + '" data-search-page="' + target + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
    }
    return '<div class="pagination">'
      + btn('首页', 1, page <= 1)
      + btn('上一页', page - 1, page <= 1)
      + '<span class="page-info">第 ' + page + ' / ' + pageCount + ' 页 · 共 ' + fmt(total) + ' 条</span>'
      + btn('下一页', page + 1, page >= pageCount)
      + btn('末页', pageCount, page >= pageCount)
      + '</div>';
  }

  /**
   * 按类型筛选查找条目
   * @param {object[]} entries 筛选前条目
   * @returns {object[]} 筛选后条目
   */
  function filterSearchEntries(entries) {
    if (searchState.typeFilter === 'all') return entries;
    const rows = [];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].type === searchState.typeFilter) rows.push(entries[i]);
    }
    return rows;
  }

  /**
   * 取（或重算）当前类型筛选后的查找结果缓存
   */
  function getFilteredSearch() {
    if (searchState.filtered) return searchState.filtered;
    searchState.filtered = {
      mobile: filterSearchEntries(searchState.results.mobile),
      remote: filterSearchEntries(searchState.results.remote),
    };
    return searchState.filtered;
  }

  /**
   * 构造一个结果分组（分组头 + 当前页条目行 / 占位）
   * @param {string} sideKey
   * @param {object[]} rows 类型筛选后的命中条目
   * @param {number} totalRows 筛选前全量条数（与筛选后不一致时附注）
   * @param {string} kwLower
   * @param {number} page
   * @param {boolean} notReady 该库未上传
   */
  function buildSearchGroupHtml(sideKey, rows, totalRows, kwLower, page, notReady) {
    let html = '<div class="result-group">';
    let countText = '命中 ' + fmt(rows.length) + ' 条';
    if (rows.length !== totalRows) countText += '（全量 ' + fmt(totalRows) + ' 条）';
    html += '<div class="group-header"><span>' + SIDE_LABELS[sideKey] + '</span>'
      + '<span class="group-count' + (rows.length === 0 ? ' zero' : '') + '">'
      + countText + '</span></div>';

    if (notReady) {
      html += '<div class="placeholder-box">该数据库尚未上传数据，请先在页面上方上传本侧全部 tree txt</div>';
    } else if (rows.length === 0) {
      html += '<div class="placeholder-box">未找到匹配条目</div>';
    } else {
      const start = (page - 1) * PAGE_SIZE;
      const slice = rows.slice(start, start + PAGE_SIZE);
      for (let i = 0; i < slice.length; i++) {
        html += buildEntryRowHtml(slice[i], kwLower, sideKey);
      }
      // 多于 1 页时才显示分页控件
      if (rows.length > PAGE_SIZE) {
        html += buildPaginationHtml(sideKey, rows.length, page);
      }
    }
    html += '</div>';
    return html;
  }

  /**
   * 查找结果分页的事件委托（只绑定一次，靠 data 属性路由）
   */
  function ensureSearchDelegate() {
    if (searchDelegateBound) return;
    const container = $('search-results');
    if (!container) return;
    container.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-search-page]');
      if (!btn || !searchState.results) return;
      const side = btn.dataset.side;
      const target = parseInt(btn.dataset.searchPage, 10);
      if ((side !== 'mobile' && side !== 'remote') || isNaN(target)) return;
      const rows = getFilteredSearch()[side];
      const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      searchState.page[side] = Math.min(Math.max(1, target), pageCount);
      renderSearchResults(); // 无参调用：按内存状态重渲染
    });
    searchDelegateBound = true;
  }

  /**
   * 更新查找页签导出按钮可用性（有结果才可导出）
   */
  function updateSearchExportState() {
    const has = searchState.results !== null
      && (searchState.results.mobile.length > 0 || searchState.results.remote.length > 0);
    const btnTxt = $('btn-export-search-txt');
    const btnCsv = $('btn-export-search-csv');
    if (btnTxt) btnTxt.disabled = !has;
    if (btnCsv) btnCsv.disabled = !has;
  }

  /**
   * 渲染查找页签结果区。
   * - 传入 results：缓存全量结果并重置页码为 1（新搜索，沿用当前类型筛选）
   * - 不传参：按内存结果、类型筛选与页码重渲染（翻页 / 筛选变化）
   * - 传入 null：清空结果区并显示输入提示
   * @param {object | null} [results] SearchResults
   */
  function renderSearchResults(results) {
    ensureSearchDelegate();
    const container = $('search-results');
    if (!container) return;

    if (typeof results !== 'undefined' && results === null) {
      // 关键词清空：复位状态（类型筛选偏好保留）
      searchState.results = null;
      searchState.filtered = null;
      searchState.page.mobile = 1;
      searchState.page.remote = 1;
    } else if (typeof results !== 'undefined' && results !== null) {
      // 新搜索结果：缓存全量并重置页码（筛选缓存失效）
      searchState.results = results;
      searchState.filtered = null;
      searchState.page.mobile = 1;
      searchState.page.remote = 1;
    }

    if (!searchState.results) {
      container.innerHTML = '<div class="placeholder-box">输入文件名关键词以开始查找，结果将按两库分组显示</div>';
      updateSearchExportState();
      return;
    }

    const ready = TDM.core.isReady();
    const kwLower = searchState.results.keyword;
    const f = getFilteredSearch();
    container.innerHTML = '<div class="results-split">'
      + buildSearchGroupHtml('mobile', f.mobile, searchState.results.mobile.length, kwLower, searchState.page.mobile, !ready.mobile)
      + buildSearchGroupHtml('remote', f.remote, searchState.results.remote.length, kwLower, searchState.page.remote, !ready.remote)
      + '</div>';
    updateSearchExportState();
  }

  /**
   * 获取当前缓存的查找结果（导出装配用，始终为类型筛选前全量）
   * @returns {object | null} SearchResults
   */
  function getSearchResults() {
    return searchState.results;
  }

  /**
   * 更新查找页签类型筛选 chips 的选中态
   */
  function updateSearchChips() {
    const group = $('search-type-filter');
    if (!group) return;
    const chips = group.querySelectorAll('.chip');
    for (let i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', chips[i].dataset.type === searchState.typeFilter);
    }
  }

  /**
   * 应用查找类型筛选（chips 点击）并重渲染
   * @param {string} type 'all' | 'file' | 'folder'
   */
  function applySearchTypeFilter(type) {
    if (type !== 'all' && type !== 'file' && type !== 'folder') return;
    if (searchState.typeFilter === type) return;
    searchState.typeFilter = type;
    updateSearchChips();
    if (!searchState.results) return; // 暂无结果：仅记住筛选偏好，待下次搜索生效
    searchState.filtered = null;      // 使筛选缓存失效
    searchState.page.mobile = 1;      // 筛选变化后回到第一页
    searchState.page.remote = 1;
    renderSearchResults();
  }

  /* ============================================================
   * 差异分析结果渲染（汇总条 / 类型筛选 / 关键词过滤 / 分页）
   * ============================================================ */

  // 差异页签的内存状态
  const diffState = {
    results: null,                          // 最近一次 DiffResults（全量）
    typeFilter: 'all',                      // 'all' | 'file' | 'folder'
    keyword: '',                            // 结果过滤关键词（已 trim + 小写）
    filtered: null,                         // 当前筛选结果缓存（避免翻页重复重算）
    page: { mobileOnly: 1, remoteOnly: 1 }, // 两分组当前页码
  };
  let diffDelegateBound = false;

  /**
   * 按类型与关键词过滤差异条目，并统计名称去重数
   * @param {object[]} entries
   * @returns {{ rows: object[], nameCount: number }}
   */
  function filterDiffEntries(entries) {
    const typeFilter = diffState.typeFilter;
    const kw = diffState.keyword;
    const rows = [];
    const names = new Set();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (typeFilter !== 'all' && e.type !== typeFilter) continue;
      if (kw.length > 0 && e.norm.indexOf(kw) < 0) continue;
      rows.push(e);
      names.add(e.norm);
    }
    return { rows: rows, nameCount: names.size };
  }

  /**
   * 取（或重算）当前筛选后的差异结果缓存
   */
  function getFilteredDiff() {
    if (diffState.filtered) return diffState.filtered;
    const m = filterDiffEntries(diffState.results.mobileOnly);
    const r = filterDiffEntries(diffState.results.remoteOnly);
    diffState.filtered = { mobileOnly: m, remoteOnly: r };
    return diffState.filtered;
  }

  /**
   * 渲染差异汇总条：主数字随当前筛选更新（spec US3 场景 2），
   * 存在筛选时附注全量数字；"两库共有"为全库固有属性，保持全量口径。
   */
  function renderDiffSummary() {
    const el = $('diff-summary');
    if (!el) return;
    const results = diffState.results;
    const f = getFilteredDiff();
    const hasFilter = diffState.typeFilter !== 'all' || diffState.keyword.length > 0;

    function item(label, nameCount, rowCount, fullNameCount, fullRowCount) {
      let s = label + '：<b>' + fmt(nameCount) + '</b> 个名称 / <b>' + fmt(rowCount) + '</b> 处';
      if (hasFilter) {
        s += '（全量 ' + fmt(fullNameCount) + ' 名称 / ' + fmt(fullRowCount) + ' 处）';
      }
      return '<span class="sum-item">' + s + '</span>';
    }

    el.innerHTML =
      item('仅移动库有', f.mobileOnly.nameCount, f.mobileOnly.rows.length,
        results.mobileOnlyNameCount, results.mobileOnly.length)
      + item('仅异地库有', f.remoteOnly.nameCount, f.remoteOnly.rows.length,
        results.remoteOnlyNameCount, results.remoteOnly.length)
      + '<span class="sum-item">两库共有：<b>' + fmt(results.commonNameCount) + '</b> 个名称</span>'
      + (diffState.keyword.length > 0
        ? '<span class="sum-item">过滤关键词：「' + escapeHtml(diffState.keyword) + '」</span>'
        : '');
    el.hidden = false;
  }

  /**
   * 构造差异结果分组（分组头 + 当前页条目行 / 占位）
   * @param {string} groupKey 'mobileOnly' | 'remoteOnly'
   * @param {string} heading 分组标题
   * @param {object[]} rows 筛选后条目
   * @param {string} sideKey 所属数据库侧（虚拟目录跳转用）
   */
  function buildDiffGroupHtml(groupKey, heading, rows, sideKey) {
    let html = '<div class="result-group">';
    html += '<div class="group-header"><span>' + heading + '</span>'
      + '<span class="group-count' + (groupKey === 'remoteOnly' ? ' only-remote' : ' only-mobile')
      + (rows.length === 0 ? ' zero' : '') + '">'
      + fmt(rows.length) + ' 处</span></div>';

    if (rows.length === 0) {
      html += '<div class="placeholder-box">当前条件下没有差异条目</div>';
    } else {
      const page = diffState.page[groupKey];
      const start = (page - 1) * PAGE_SIZE;
      const slice = rows.slice(start, start + PAGE_SIZE);
      for (let i = 0; i < slice.length; i++) {
        // 差异分组不做关键词高亮（过滤词为隐藏条件而非高亮需求）
        html += buildEntryRowHtml(slice[i], '', sideKey);
      }
      if (rows.length > PAGE_SIZE) {
        html += buildDiffPaginationHtml(groupKey, rows.length, page);
      }
    }
    html += '</div>';
    return html;
  }

  /**
   * 构造差异分页控件（data-diff-page 供事件委托识别）
   */
  function buildDiffPaginationHtml(groupKey, total, page) {
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    function btn(label, target, disabled) {
      return '<button type="button" class="page-btn" data-diff-group="' + groupKey
        + '" data-diff-page="' + target + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
    }
    return '<div class="pagination">'
      + btn('首页', 1, page <= 1)
      + btn('上一页', page - 1, page <= 1)
      + '<span class="page-info">第 ' + page + ' / ' + pageCount + ' 页 · 共 ' + fmt(total) + ' 条</span>'
      + btn('下一页', page + 1, page >= pageCount)
      + btn('末页', pageCount, page >= pageCount)
      + '</div>';
  }

  /**
   * 差异结果分页的事件委托（只绑定一次）
   */
  function ensureDiffDelegate() {
    if (diffDelegateBound) return;
    const container = $('diff-results');
    if (!container) return;
    container.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-diff-page]');
      if (!btn || !diffState.results) return;
      const group = btn.dataset.diffGroup;
      const target = parseInt(btn.dataset.diffPage, 10);
      if ((group !== 'mobileOnly' && group !== 'remoteOnly') || isNaN(target)) return;
      const rows = getFilteredDiff()[group].rows;
      const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      diffState.page[group] = Math.min(Math.max(1, target), pageCount);
      renderDiffResults(); // 无参调用：按内存状态重渲染
    });
    diffDelegateBound = true;
  }

  /**
   * 更新差异页签导出按钮可用性（有结果才可导出；导出始终为筛选前全量）
   */
  function updateDiffExportState() {
    const has = diffState.results !== null
      && (diffState.results.mobileOnly.length > 0 || diffState.results.remoteOnly.length > 0);
    const btnTxt = $('btn-export-diff-txt');
    const btnCsv = $('btn-export-diff-csv');
    if (btnTxt) btnTxt.disabled = !has;
    if (btnCsv) btnCsv.disabled = !has;
  }

  /**
   * 更新类型筛选 chips 的选中态
   */
  function updateDiffChips() {
    const group = $('diff-type-filter');
    if (!group) return;
    const chips = group.querySelectorAll('.chip');
    for (let i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', chips[i].dataset.type === diffState.typeFilter);
    }
  }

  /**
   * 渲染差异页签。
   * - 传入 results（新分析完成）：缓存全量结果、重置筛选与页码、显示筛选器
   * - 不传参：按内存状态重渲染（翻页 / 筛选变化）
   * @param {object} [results] DiffResults
   */
  function renderDiffResults(results) {
    ensureDiffDelegate();
    const container = $('diff-results');
    if (!container) return;

    if (typeof results !== 'undefined' && results !== null) {
      diffState.results = results;
      diffState.typeFilter = 'all';
      diffState.keyword = '';
      diffState.filtered = null;
      diffState.page.mobileOnly = 1;
      diffState.page.remoteOnly = 1;
      // 显示筛选控件并复位其 UI 状态
      const chips = $('diff-type-filter');
      const filterInput = $('diff-filter-input');
      if (chips) chips.hidden = false;
      if (filterInput) { filterInput.hidden = false; filterInput.value = ''; }
      updateDiffChips();
    }

    if (!diffState.results) {
      container.innerHTML = '<div class="placeholder-box">两侧数据均就绪后，点击「开始分析」比较两库差异</div>';
      updateDiffExportState();
      return;
    }

    renderDiffSummary();
    const f = getFilteredDiff();
    container.innerHTML = '<div class="results-split">'
      + buildDiffGroupHtml('mobileOnly', '仅移动库有', f.mobileOnly.rows, 'mobile')
      + buildDiffGroupHtml('remoteOnly', '仅异地库有', f.remoteOnly.rows, 'remote')
      + '</div>';
    updateDiffExportState();
  }

  /**
   * 应用类型筛选（chips 点击）并重渲染
   * @param {string} type 'all' | 'file' | 'folder'
   */
  function applyDiffTypeFilter(type) {
    if (!diffState.results) return;
    if (type !== 'all' && type !== 'file' && type !== 'folder') return;
    if (diffState.typeFilter === type) return;
    diffState.typeFilter = type;
    diffState.filtered = null;      // 使筛选缓存失效
    diffState.page.mobileOnly = 1;  // 筛选变化后回到第一页
    diffState.page.remoteOnly = 1;
    updateDiffChips();
    renderDiffResults();
  }

  /**
   * 应用关键词过滤（过滤框输入）并重渲染
   * @param {string} keyword 原始输入
   */
  function applyDiffKeyword(keyword) {
    if (!diffState.results) return;
    diffState.keyword = String(keyword || '').trim().toLowerCase();
    diffState.filtered = null;
    diffState.page.mobileOnly = 1;
    diffState.page.remoteOnly = 1;
    renderDiffResults();
  }

  /**
   * 获取当前缓存的差异结果（导出装配用，始终为筛选前全量）
   * @returns {object | null} DiffResults
   */
  function getDiffResults() {
    return diffState.results;
  }

  /* ============================================================
   * 页签激活（页签点击与编程式跳转共用）
   * ============================================================ */

  /**
   * 激活指定面板对应的页签（其余页签与面板全部取消激活）。
   * 虚拟目录面板内容仅在切换/跳转时渲染，切入时须基于最新数据刷新。
   * @param {string} panelId 目标面板 id
   */
  function activateTab(panelId) {
    if (!panelId) return;
    const tabs = document.querySelectorAll('.tab');
    for (let i = 0; i < tabs.length; i++) {
      const active = tabs[i].dataset.panel === panelId;
      tabs[i].classList.toggle('active', active);
      tabs[i].setAttribute('aria-selected', active ? 'true' : 'false');
    }
    const panels = document.querySelectorAll('.panel');
    for (let i = 0; i < panels.length; i++) {
      panels[i].classList.toggle('active', panels[i].id === panelId);
    }
    if (panelId === 'panel-tree') renderTreePanel();
  }

  /* ============================================================
   * 虚拟目录浏览（基于 tree txt 内容映射的层级浏览 + 结果定位）
   * ============================================================ */

  // 虚拟目录页签的内存状态：左右两列独立浏览（左列移动库 / 右列异地库），
  // partition 为 null 表示该列显示分区总览
  const treeState = {
    mobile: { partition: null, path: null, highlight: null },
    remote: { partition: null, path: null, highlight: null },
  };

  /**
   * 取某一侧的浏览状态
   * @param {string} sideKey 'mobile' | 'remote'
   */
  function getTreeSideState(sideKey) {
    return sideKey === 'remote' ? treeState.remote : treeState.mobile;
  }

  /**
   * 在侧树中按分区名查找分区树
   * @param {string} sideKey
   * @param {string} partitionName
   */
  function findPartitionTree(sideKey, partitionName) {
    const sideTree = TDM.core.getSideTree(sideKey);
    if (!sideTree) return null;
    const list = sideTree.partitions;
    for (let i = 0; i < list.length; i++) {
      if (list[i].partition === partitionName) return list[i];
    }
    return null;
  }

  /**
   * 构造某一侧的分区总览内容（该侧全部分区 = 各硬盘入口），点击进入根目录
   * @param {string} sideKey
   */
  function buildTreeSideOverviewHtml(sideKey) {
    const sideTree = TDM.core.getSideTree(sideKey);
    const parts = sideTree ? sideTree.partitions : [];
    let html = '<div class="group-header"><span>' + SIDE_LABELS[sideKey] + '</span>'
      + '<span class="group-count' + (parts.length === 0 ? ' zero' : '') + '">'
      + parts.length + ' 个分区</span></div>';
    let body = '';
    if (parts.length === 0) {
      body = '<div class="placeholder-box">该数据库尚未上传数据，请先在页面上方上传本侧全部 tree txt</div>';
    } else {
      for (let i = 0; i < parts.length; i++) {
        const pt = parts[i];
        if (pt.rootNode === null) {
          body += '<div class="tree-partition-row invalid">'
            + entryIconHtml('disk')
            + '<span class="tree-partition-name" title="' + escapeHtml(pt.partition) + '">' + escapeHtml(pt.partition) + '</span>'
            + '<span class="tree-partition-meta">未解析出有效目录结构</span>'
            + '</div>';
        } else {
          body += '<div class="tree-partition-row" data-tree-partition'
            + ' data-side="' + sideKey + '"'
            + ' data-partition="' + escapeHtml(pt.partition) + '"'
            + ' title="点击浏览该硬盘目录">'
            + entryIconHtml('disk')
            + '<span class="tree-partition-name" title="' + escapeHtml(pt.partition) + '">' + escapeHtml(pt.partition) + '</span>'
            + '<span class="tree-partition-meta">'
            + '<span class="badge badge-folder">' + escapeHtml(pt.root || '') + '</span>'
            + '<span>' + fmt(pt.entryCount) + ' 条</span>'
            + '</span>'
            + '</div>';
        }
      }
    }
    /* 分区行包进列滚动区：列固定高度时内容过多在列内纵向滚动 */
    return html + '<div class="tree-col-scroll">' + body + '</div>';
  }

  /**
   * 构造面包屑：分区列表 › 分区名 › 根路径 › … › 当前目录
   * @param {string} sideKey
   * @param {object} pt 分区树
   * @param {object} node 当前目录节点
   */
  function buildTreeCrumbHtml(sideKey, pt, node) {
    const chain = [];
    let cur = node;
    while (cur !== null) { chain.push(cur); cur = cur.parent; }
    chain.reverse();
    let html = '<span class="crumb" data-tree-overview'
      + ' data-side="' + sideKey + '"'
      + ' title="返回该侧分区列表">分区列表</span>'
      + '<span class="crumb-sep">›</span>'
      + '<span class="crumb crumb-static" title="' + escapeHtml(pt.partition) + '">' + escapeHtml(pt.partition) + '</span>';
    for (let i = 0; i < chain.length; i++) {
      const n = chain[i];
      html += '<span class="crumb-sep">›</span>';
      if (i === chain.length - 1) {
        html += '<span class="crumb crumb-current" title="' + escapeHtml(n.path) + '">' + escapeHtml(n.name) + '</span>';
      } else {
        html += '<span class="crumb" data-tree-crumb'
          + ' data-side="' + sideKey + '"'
          + ' data-partition="' + escapeHtml(pt.partition) + '"'
          + ' data-path="' + escapeHtml(n.path) + '"'
          + ' title="跳转到 ' + escapeHtml(n.path) + '">' + escapeHtml(n.name) + '</span>';
      }
    }
    return html;
  }

  /**
   * 构造目录内容列表：文件夹在前（可点击进入），文件在后
   * @param {string} sideKey
   * @param {object} pt 分区树
   * @param {object} node 当前目录节点
   */
  function buildTreeDirHtml(sideKey, pt, node) {
    const children = Array.from(node.children.values());
    if (children.length === 0) {
      return '<div class="placeholder-box">该文件夹为空</div>';
    }
    const folders = [];
    const files = [];
    for (let i = 0; i < children.length; i++) {
      if (children[i].type === 'folder') folders.push(children[i]);
      else files.push(children[i]);
    }
    folders.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-CN'); });
    files.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-CN'); });
    let html = '';
    for (let i = 0; i < folders.length; i++) {
      const n = folders[i];
      html += '<div class="tree-row tree-folder"'
        + ' data-side="' + sideKey + '"'
        + ' data-partition="' + escapeHtml(pt.partition) + '"'
        + ' data-path="' + escapeHtml(n.path) + '"'
        + ' title="点击进入该文件夹">'
        + entryIconHtml('folder')
        + '<span class="result-name" title="' + escapeHtml(n.path) + '">' + escapeHtml(n.name) + '</span>'
        + '<span class="badge badge-folder">文件夹</span>'
        + '<span class="tree-count">' + (n.folderCount + n.fileCount) + ' 项</span>'
        + '</div>';
    }
    for (let i = 0; i < files.length; i++) {
      const n = files[i];
      html += '<div class="tree-row"'
        + ' data-path="' + escapeHtml(n.path) + '">'
        + entryIconHtml(fileIconKind(n.name))
        + '<span class="result-name" title="' + escapeHtml(n.path) + '">' + escapeHtml(n.name) + '</span>'
        + '<span class="badge badge-file">文件</span>'
        + '</div>';
    }
    return html;
  }

  /**
   * 构造某一侧的目录列：列头（库名 + 条数）+ 面包屑（浏览中）+ 列内容
   * （分区总览或目录行）；该侧浏览位置失效时仅回退该侧总览。
   * @param {string} sideKey
   */
  function buildTreeColumnHtml(sideKey) {
    const st = getTreeSideState(sideKey);
    let html = '<div class="tree-column" data-side="' + sideKey + '">';
    if (st.partition === null) {
      html += buildTreeSideOverviewHtml(sideKey);
    } else {
      const pt = findPartitionTree(sideKey, st.partition);
      const node = pt !== null ? pt.nodes.get(st.path) : null;
      if (!node || node.type !== 'folder') {
        // 该侧浏览位置已失效：回退该侧分区总览
        st.partition = null;
        st.path = null;
        st.highlight = null;
        html += buildTreeSideOverviewHtml(sideKey);
      } else {
        html += '<div class="group-header"><span>' + SIDE_LABELS[sideKey] + '</span>'
          + '<span class="group-count">' + fmt(node.children.size) + ' 项</span></div>'
          + '<div class="breadcrumb">' + buildTreeCrumbHtml(sideKey, pt, node) + '</div>'
          + '<div class="tree-col-scroll">' + buildTreeDirHtml(sideKey, pt, node) + '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  /**
   * 渲染虚拟目录页签：左右两列独立浏览（左列移动库 / 右列异地库）。
   * 每列各自显示分区总览或当前目录内容；跳转高亮在对应列内定位。
   */
  function renderTreePanel() {
    const container = $('tree-results');
    if (!container) return;
    container.innerHTML = '<div class="results-split">'
      + buildTreeColumnHtml('mobile')
      + buildTreeColumnHtml('remote')
      + '</div>';

    // 一次性高亮 + 滚动定位（由查找/差异结果跳转触发，在目标列内定位）
    const sideKeys = ['mobile', 'remote'];
    for (let s = 0; s < sideKeys.length; s++) {
      const st = getTreeSideState(sideKeys[s]);
      if (st.highlight === null) continue;
      const col = container.querySelector('.tree-column[data-side="' + sideKeys[s] + '"]');
      if (col !== null) {
        const rows = col.querySelectorAll('.tree-row');
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].dataset.path === st.highlight) {
            rows[i].classList.add('tree-highlight');
            rows[i].scrollIntoView({ block: 'center' });
            break;
          }
        }
      }
      st.highlight = null;
    }
  }

  /**
   * 某一侧返回分区总览（另一侧浏览位置保持不变）
   * @param {string} sideKey 'mobile' | 'remote'
   */
  function treeShowSideOverview(sideKey) {
    if (sideKey !== 'mobile' && sideKey !== 'remote') return;
    const st = getTreeSideState(sideKey);
    st.partition = null;
    st.path = null;
    st.highlight = null;
    renderTreePanel();
  }

  /**
   * 打开指定侧的目录（仅影响该侧列；位置失效自动回退该侧总览）
   * @param {string} sideKey
   * @param {string} partition 分区名
   * @param {string} path 目录完整路径
   * @param {string} [highlight] 进入后待高亮条目路径
   */
  function treeOpenDir(sideKey, partition, path, highlight) {
    if (sideKey !== 'mobile' && sideKey !== 'remote') return;
    const st = getTreeSideState(sideKey);
    st.partition = partition;
    st.path = path;
    st.highlight = highlight || null;
    renderTreePanel();
  }

  /**
   * 打开某分区的根目录（分区总览行点击）
   * @param {string} sideKey
   * @param {string} partition
   */
  function treeOpenPartition(sideKey, partition) {
    const pt = findPartitionTree(sideKey, partition);
    if (pt === null || pt.rootNode === null) return;
    treeOpenDir(sideKey, partition, pt.rootNode.path);
  }

  /**
   * 结果跳转入口：在虚拟目录中打开条目所在位置。
   *  - 文件夹条目：直接进入该文件夹内部
   *  - 文件条目：打开其所在文件夹并高亮定位该文件
   * 先更新浏览状态再激活页签（activateTab 内统一渲染，避免二次渲染闪烁）。
   * 定位失败（数据已变更等）不切换页签，仅提示。
   * @param {string} sideKey 'mobile' | 'remote'
   * @param {string} partition 来源分区名
   * @param {string} path 条目完整路径
   */
  function openTreeBrowser(sideKey, partition, path) {
    if (!sideKey || !partition || !path) return;
    if (sideKey !== 'mobile' && sideKey !== 'remote') return;
    const pt = findPartitionTree(sideKey, partition);
    if (pt === null) {
      toast('未找到该条目对应的分区，数据可能已变更', 'error');
      return;
    }
    const node = pt.nodes.get(path);
    if (!node) {
      toast('未找到该条目对应的目录，数据可能已变更', 'error');
      return;
    }
    const st = getTreeSideState(sideKey);
    st.partition = partition;
    if (node.type === 'file' && node.parent !== null) {
      st.path = node.parent.path;
      st.highlight = node.path;
    } else {
      st.path = node.path;
      st.highlight = null;
    }
    activateTab('panel-tree');
  }

  /**
   * 数据变更后使两列浏览位置均复位到分区总览（浏览位置随旧数据失效）；
   * 仅当页签处于激活态时立即重渲染，避免无关场景的树构建开销。
   */
  function treeReset() {
    const sideKeys = ['mobile', 'remote'];
    for (let i = 0; i < sideKeys.length; i++) {
      const st = treeState[sideKeys[i]];
      st.partition = null;
      st.path = null;
      st.highlight = null;
    }
    const panel = $('panel-tree');
    if (panel !== null && panel.classList.contains('active')) renderTreePanel();
  }

  /* ---------- 挂载 ---------- */
  ui.escapeHtml = escapeHtml;
  ui.fmt = fmt;
  ui.toast = toast;
  ui.setBusy = setBusy;
  ui.renderSideStats = renderSideStats;
  ui.updateFunctionStates = updateFunctionStates;
  ui.updateStaleTip = updateStaleTip;
  ui.notifyDataChanged = notifyDataChanged;
  ui.SIDE_LABELS = SIDE_LABELS;
  ui.renderSearchResults = renderSearchResults;
  ui.getSearchResults = getSearchResults;
  ui.applySearchTypeFilter = applySearchTypeFilter;
  ui.buildEntryRowHtml = buildEntryRowHtml;
  ui.renderDiffResults = renderDiffResults;
  ui.applyDiffTypeFilter = applyDiffTypeFilter;
  ui.applyDiffKeyword = applyDiffKeyword;
  ui.getDiffResults = getDiffResults;
  ui.activateTab = activateTab;
  ui.renderTreePanel = renderTreePanel;
  ui.treeShowSideOverview = treeShowSideOverview;
  ui.treeOpenPartition = treeOpenPartition;
  ui.treeOpenDir = treeOpenDir;
  ui.openTreeBrowser = openTreeBrowser;
})();

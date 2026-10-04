/**
 * main.js - 入口装配：事件绑定与启动
 *
 * 装配内容（随任务推进逐步扩充）：
 *  - 页签切换
 *  - 上传交互（点击选择 / 拖拽 / 键盘触发）→ TDM.core.addFiles
 *  - 单侧清空 → TDM.core.resetSide
 *  - 单侧合并下载 → TDM.exporter.downloadMergedTxt
 */
(function () {
  'use strict';

  const TDM = window.TDM;

  function $(id) {
    return document.getElementById(id);
  }

  function sideLabel(sideKey) {
    return sideKey === 'mobile' ? '移动数据库' : '异地数据库';
  }

  /* ---------- 页签切换 ---------- */

  function bindTabs() {
    const tabs = document.querySelectorAll('.tab');
    for (let i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        TDM.ui.activateTab(this.dataset.panel);
      });
    }
  }

  /* ---------- 上传交互 ---------- */

  // 两侧上传元素的 id 约定
  const SIDES = [
    { key: 'mobile', drop: 'drop-mobile', file: 'file-mobile', clear: 'btn-clear-mobile', merge: 'btn-merge-mobile' },
    { key: 'remote', drop: 'drop-remote', file: 'file-remote', clear: 'btn-clear-remote', merge: 'btn-merge-remote' },
  ];

  /**
   * 处理一次文件接入（选择或拖拽）：过滤非 txt → 忙碌遮罩 → 解析 → 渲染统计
   * @param {'mobile' | 'remote'} sideKey
   * @param {FileList | File[]} fileList
   */
  function handleFiles(sideKey, fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    if (files.length === 0) return;

    // 过滤非 .txt 文件并提示
    const txtFiles = [];
    const rejected = [];
    for (let i = 0; i < files.length; i++) {
      if (files[i].name.toLowerCase().endsWith('.txt')) txtFiles.push(files[i]);
      else rejected.push(files[i].name);
    }
    if (rejected.length > 0) {
      const shown = rejected.slice(0, 3).join('、');
      TDM.ui.toast('已忽略 ' + rejected.length + ' 个非 txt 文件：' + shown
        + (rejected.length > 3 ? ' 等' : ''), 'error');
    }
    if (txtFiles.length === 0) return;

    TDM.ui.setBusy(true, '正在解析 ' + txtFiles.length + ' 个文件，请稍候…');
    TDM.core.addFiles(sideKey, txtFiles).then(function (stats) {
      TDM.ui.setBusy(false);
      TDM.ui.renderSideStats(sideKey, stats);
      TDM.ui.notifyDataChanged(sideKey);
      if (stats.invalidFiles.length > 0) {
        const shown = stats.invalidFiles.slice(0, 3).join('、');
        TDM.ui.toast('警告：' + stats.invalidFiles.length + ' 个文件未解析出有效条目：' + shown
          + (stats.invalidFiles.length > 3 ? ' 等' : ''), 'error');
      } else {
        TDM.ui.toast('「' + sideLabel(sideKey) + '」解析完成：'
          + stats.partitionCount + ' 个分区，'
          + TDM.ui.fmt(stats.folderCount) + ' 个文件夹，'
          + TDM.ui.fmt(stats.fileCount) + ' 个文件', 'info');
      }
    }).catch(function () {
      TDM.ui.setBusy(false);
      TDM.ui.toast('文件解析失败，请重试', 'error');
    });
  }

  /** 绑定某一侧的上传事件（点击/键盘/拖拽/文件选择） */
  function bindUploadSide(s) {
    const dz = $(s.drop);
    const input = $(s.file);
    if (!dz || !input) return;

    // 点击拖拽区任意位置（含内部"选择文件"按钮，事件冒泡）触发文件选择
    dz.addEventListener('click', function () { input.click(); });
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });

    // 拖拽：dragover 持续加高亮；仅当真正离开拖拽区时移除
    dz.addEventListener('dragover', function (e) {
      e.preventDefault();
      dz.classList.add('dragover');
    });
    dz.addEventListener('dragleave', function (e) {
      if (!dz.contains(e.relatedTarget)) dz.classList.remove('dragover');
    });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      dz.classList.remove('dragover');
      handleFiles(s.key, e.dataTransfer.files);
    });

    // 文件选择（change 后重置 value，允许再次选择同一批文件）
    input.addEventListener('change', function () {
      handleFiles(s.key, input.files);
      input.value = '';
    });
  }

  /* ---------- 单侧清空 ---------- */

  function bindClearSide(s) {
    const btn = $(s.clear);
    if (!btn) return;
    btn.addEventListener('click', function () {
      TDM.core.resetSide(s.key);
      TDM.ui.renderSideStats(s.key, null);
      TDM.ui.notifyDataChanged(s.key);
      TDM.ui.toast('已清空「' + sideLabel(s.key) + '」', 'info');
    });
  }

  /* ---------- 单侧合并下载 ---------- */

  /** 合并该侧全部 txt 为单个文件并下载（重新上传该文件可自动还原各分区） */
  function bindMergeSide(s) {
    const btn = $(s.merge);
    if (!btn) return;
    btn.addEventListener('click', function () {
      const partitions = TDM.core.getPartitions(s.key);
      if (partitions.length === 0) {
        TDM.ui.toast('「' + sideLabel(s.key) + '」尚未上传数据，无可合并的 txt', 'error');
        return;
      }
      TDM.exporter.downloadMergedTxt(sideLabel(s.key) + '合并', sideLabel(s.key), partitions);
      TDM.ui.toast('已合并下载「' + sideLabel(s.key) + '」全部 ' + partitions.length + ' 个分区', 'info');
    });
  }

  /* ---------- 模糊查找（300ms 防抖，输入即时响应） ---------- */

  const SEARCH_DEBOUNCE_MS = 300;

  function bindSearch() {
    const input = $('search-input');
    if (!input) return;
    let timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        // 空白关键词：不执行搜索，复位结果区为输入提示
        if (input.value.trim().length === 0) {
          TDM.ui.renderSearchResults(null);
          return;
        }
        const results = TDM.core.search(input.value);
        if (results === null) {
          TDM.ui.renderSearchResults(null);
          return;
        }
        TDM.ui.renderSearchResults(results);
      }, SEARCH_DEBOUNCE_MS);
    });

    // 类型筛选 chips
    const chipGroup = $('search-type-filter');
    if (chipGroup) {
      chipGroup.addEventListener('click', function (e) {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        TDM.ui.applySearchTypeFilter(chip.dataset.type);
      });
    }
  }

  /* ---------- 差异分析 ---------- */

  // 过滤框输入防抖
  const DIFF_FILTER_DEBOUNCE_MS = 300;

  function bindDiff() {
    // 开始分析按钮
    const btnDiff = $('btn-diff');
    if (btnDiff) {
      btnDiff.addEventListener('click', function () {
        const ready = TDM.core.isReady();
        if (!ready.mobile || !ready.remote) {
          // 数据不全时的降级提示
          TDM.ui.toast('请先上传两侧数据后再进行差异分析', 'error');
          return;
        }
        // 先渲染忙碌遮罩，再执行同步比较（setTimeout 让浏览器完成一次绘制）
        TDM.ui.setBusy(true, '正在比较两库差异，请稍候…');
        setTimeout(function () {
          try {
            const results = TDM.core.computeDiff();
            TDM.ui.setBusy(false);
            if (results === null) {
              TDM.ui.toast('数据不完整，无法执行差异分析', 'error');
              return;
            }
            TDM.ui.renderDiffResults(results);
            TDM.ui.updateStaleTip(); // 新结果非过期，隐藏提示条
            TDM.ui.toast('差异分析完成：仅移动库 ' + TDM.ui.fmt(results.mobileOnlyNameCount)
              + ' 个名称，仅异地库 ' + TDM.ui.fmt(results.remoteOnlyNameCount) + ' 个名称', 'info');
          } catch (e) {
            TDM.ui.setBusy(false);
            TDM.ui.toast('差异分析失败，请重试', 'error');
          }
        }, 30);
      });
    }

    // 类型筛选 chips
    const chipGroup = $('diff-type-filter');
    if (chipGroup) {
      chipGroup.addEventListener('click', function (e) {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        TDM.ui.applyDiffTypeFilter(chip.dataset.type);
      });
    }

    // 结果关键词过滤（防抖）
    const filterInput = $('diff-filter-input');
    if (filterInput) {
      let timer = null;
      filterInput.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          TDM.ui.applyDiffKeyword(filterInput.value);
        }, DIFF_FILTER_DEBOUNCE_MS);
      });
    }
  }

  /* ---------- 虚拟目录浏览 ---------- */

  /**
    * 虚拟目录页签交互装配（左右两列独立浏览）：
    *  - 分区总览行 / 目录文件夹行点击 → 进入对应侧列的目录
    *  - 面包屑点击 → 跳转上级目录或返回该侧分区总览
    *  - 查找 / 差异结果行点击 → 对应侧列中定位条目所在文件夹
    *    （分页按钮位于 .pagination 内，不会命中 .result-row，与分页委托互不影响）
    */
  function bindTreeBrowser() {
    const container = $('tree-results');
    if (container) {
      container.addEventListener('click', function (e) {
        const partRow = e.target.closest('[data-tree-partition]');
        if (partRow) {
          TDM.ui.treeOpenPartition(partRow.dataset.side, partRow.dataset.partition);
          return;
        }
        const folderRow = e.target.closest('.tree-row.tree-folder');
        if (folderRow) {
          TDM.ui.treeOpenDir(folderRow.dataset.side, folderRow.dataset.partition, folderRow.dataset.path);
          return;
        }
        const overview = e.target.closest('[data-tree-overview]');
        if (overview) {
          TDM.ui.treeShowSideOverview(overview.dataset.side);
          return;
        }
        const crumb = e.target.closest('[data-tree-crumb]');
        if (crumb) {
          TDM.ui.treeOpenDir(crumb.dataset.side, crumb.dataset.partition, crumb.dataset.path);
        }
      });
    }

    const searchResults = $('search-results');
    if (searchResults) {
      searchResults.addEventListener('click', function (e) {
        const row = e.target.closest('.result-row');
        if (!row) return;
        TDM.ui.openTreeBrowser(row.dataset.side, row.dataset.partition, row.dataset.path);
      });
    }

    const diffResults = $('diff-results');
    if (diffResults) {
      diffResults.addEventListener('click', function (e) {
        const row = e.target.closest('.result-row');
        if (!row) return;
        TDM.ui.openTreeBrowser(row.dataset.side, row.dataset.partition, row.dataset.path);
      });
    }
  }

  /* ---------- 结果导出（查找/差异均导出类型筛选前的全量结果） ---------- */

  /**
   * 导出前缀中的关键词片段：截断并交由 exporter 清理非法字符
   */
  function keywordSnippet(kw) {
    const s = String(kw || '').trim().slice(0, 20);
    return s.length > 0 ? s : '结果';
  }

  function bindExport() {
    // ----- 查找结果导出 -----
    const btnSearchTxt = $('btn-export-search-txt');
    const btnSearchCsv = $('btn-export-search-csv');

    function exportSearch(kind) {
      const results = TDM.ui.getSearchResults();
      if (!results) {
        TDM.ui.toast('暂无查找结果可导出', 'error');
        return;
      }
      const kw = results.keyword;
      const prefix = '模糊查找_' + keywordSnippet(kw);
      const title = '模糊查找结果 - 关键词：「' + kw + '」';
      const sections = [
        { heading: '移动数据库（' + results.mobile.length + ' 条）', rows: results.mobile },
        { heading: '异地数据库（' + results.remote.length + ' 条）', rows: results.remote },
      ];
      if (kind === 'txt') {
        TDM.exporter.downloadTxt(prefix, title, sections);
      } else {
        const rows = [];
        for (let i = 0; i < results.mobile.length; i++) {
          rows.push({ group: '移动数据库', entry: results.mobile[i] });
        }
        for (let i = 0; i < results.remote.length; i++) {
          rows.push({ group: '异地数据库', entry: results.remote[i] });
        }
        TDM.exporter.downloadCsv(prefix, rows);
      }
      TDM.ui.toast('已导出查找结果（' + kind.toUpperCase() + '）', 'info');
    }

    if (btnSearchTxt) btnSearchTxt.addEventListener('click', function () { exportSearch('txt'); });
    if (btnSearchCsv) btnSearchCsv.addEventListener('click', function () { exportSearch('csv'); });

    // ----- 差异结果导出（始终导出筛选前全量） -----
    const btnDiffTxt = $('btn-export-diff-txt');
    const btnDiffCsv = $('btn-export-diff-csv');

    function exportDiff(kind) {
      const results = TDM.ui.getDiffResults();
      if (!results) {
        TDM.ui.toast('暂无差异分析结果可导出', 'error');
        return;
      }
      const sections = [
        { heading: '仅移动库有（' + results.mobileOnly.length + ' 处）', rows: results.mobileOnly },
        { heading: '仅异地库有（' + results.remoteOnly.length + ' 处）', rows: results.remoteOnly },
      ];
      if (kind === 'txt') {
        TDM.exporter.downloadTxt('差异分析', '差异分析结果（按名称比较，不区分大小写）', sections);
      } else {
        const rows = [];
        for (let i = 0; i < results.mobileOnly.length; i++) {
          rows.push({ group: '仅移动库有', entry: results.mobileOnly[i] });
        }
        for (let i = 0; i < results.remoteOnly.length; i++) {
          rows.push({ group: '仅异地库有', entry: results.remoteOnly[i] });
        }
        TDM.exporter.downloadCsv('差异分析', rows);
      }
      TDM.ui.toast('已导出差异分析结果（' + kind.toUpperCase() + '）', 'info');
    }

    if (btnDiffTxt) btnDiffTxt.addEventListener('click', function () { exportDiff('txt'); });
    if (btnDiffCsv) btnDiffCsv.addEventListener('click', function () { exportDiff('csv'); });
  }

  /* ---------- 主题切换（白天/黑夜，偏好持久化到 localStorage） ---------- */

  const THEME_KEY = 'tdm-theme'; // 与 index.html head 内联恢复脚本保持一致

  function isDarkTheme() {
    return document.documentElement.classList.contains('theme-dark');
  }

  // 图标按钮显示目标模式（白天显示月亮/黑夜显示太阳），这里仅同步无障碍提示
  function syncThemeButton() {
    const btn = $('btn-theme');
    if (!btn) return;
    const dark = isDarkTheme();
    const target = dark ? '切换到白天模式' : '切换到黑夜模式';
    btn.title = target;
    btn.setAttribute('aria-label', target);
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }

  function setTheme(dark) {
    document.documentElement.classList.toggle('theme-dark', dark);
    syncThemeButton();
    try {
      localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    } catch (e) {
      // 隐私模式等无法持久化的环境：仅本次会话生效
    }
  }

  function bindThemeToggle() {
    const btn = $('btn-theme');
    if (!btn) return;
    syncThemeButton(); // 初始态由 head 内联脚本恢复，这里仅同步按钮显示
    btn.addEventListener('click', function () {
      setTheme(!isDarkTheme());
    });
  }

  /* ---------- 启动 ---------- */

  function init() {
    bindThemeToggle();
    bindTabs();
    bindSearch();
    bindDiff();
    bindExport();
    bindTreeBrowser();
    for (let i = 0; i < SIDES.length; i++) {
      bindUploadSide(SIDES[i]);
      bindClearSide(SIDES[i]);
      bindMergeSide(SIDES[i]);
    }
    // 初始占位渲染与功能入口状态
    TDM.ui.renderSideStats('mobile', null);
    TDM.ui.renderSideStats('remote', null);
    TDM.ui.renderSearchResults(null);
    TDM.ui.renderDiffResults(null);
    TDM.ui.renderTreePanel();
    TDM.ui.updateFunctionStates();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

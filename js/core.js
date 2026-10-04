/**
 * TDM.core - 双库内存存储、统计与业务逻辑
 *
 * 职责：
 *  1. 维护移动库 / 异地库两侧的 SideData（分区清单、展平条目、归一化名称集合、统计）
 *  2. addFiles：FileReader 读取 → 编码探测解码 → tree 解析（自动识别本系统导出的
 *     合并 txt 并按标记拆回多分区）→ 按来源文件名覆盖式并入 → 重算
 *  3. resetSide / getStats / getPartitions / isReady
 *  4. 数据变更后使已有差异分析结果置 stale（过期提示）
 *
 * 所有数据仅存于页面内存，不做持久化。
 */
(function () {
  'use strict';

  const TDM = (window.TDM = window.TDM || {});
  const core = (TDM.core = TDM.core || {});

  /* ---------- 内部状态 ---------- */

  // 两侧数据（key: 'mobile' | 'remote'）
  const sides = {
    mobile: makeSide('mobile', '移动数据库'),
    remote: makeSide('remote', '异地数据库'),
  };

  // 最近一次差异分析结果缓存（stale 机制的载体）
  let diffCache = null;

  /**
   * 构造一个数据库侧的空数据结构
   * @param {string} key
   * @param {string} label
   */
  function makeSide(key, label) {
    return {
      key: key,
      label: label,
      partitionMap: new Map(), // fileName -> Partition（Map 语义天然支持覆盖式去重）
      entries: [],             // 全部分区条目展平（查找/差异扫描源）
      nameSet: new Set(),      // 库内归一化名称集合（差异比较用）
      stats: null,             // SideStats | null
      tree: null,              // 侧级虚拟目录树缓存（getSideTree 惰性构建）
      treeDirty: true,         // 数据变更后置 true，下次取树时重建
    };
  }

  /**
   * 数据变更后将已有差异结果标记为过期（UI 提示重新分析）
   */
  function invalidateDiff() {
    if (diffCache !== null) diffCache.stale = true;
  }

  /**
   * 重算侧级数据：展平 entries、重建 nameSet、汇总统计
   * @param {object} side
   */
  function recomputeSide(side) {
    const entries = [];
    const nameSet = new Set();
    let folderCount = 0;
    let fileCount = 0;
    const invalidFiles = [];

    side.partitionMap.forEach(function (p) {
      for (let i = 0; i < p.entries.length; i++) {
        const e = p.entries[i];
        entries.push(e);
        nameSet.add(e.norm);
      }
      folderCount += p.folderCount;
      fileCount += p.fileCount;
      if (!p.hasValidContent) invalidFiles.push(p.fileName);
    });

    side.entries = entries;
    side.nameSet = nameSet;
    side.stats = {
      partitionCount: side.partitionMap.size,
      folderCount: folderCount,
      fileCount: fileCount,
      invalidFiles: invalidFiles,
    };
    side.treeDirty = true; // 数据已重算，虚拟目录树缓存失效
  }

  /**
   * 取指定侧（未知 key 返回 null）
   * @param {string} sideKey
   */
  function getSide(sideKey) {
    return sides[sideKey] || null;
  }

  /* ---------- 文件读取与解析 ---------- */

  /**
   * 组装分区对象（保留原始解码文本，供"合并下载"原样复用）
   * @param {string} fileName 分区名（= 来源 txt 文件名）
   * @param {object} parsed parseTreeText 结果
   * @param {string} rawText 原始解码文本
   */
  function makePartition(fileName, parsed, rawText) {
    return {
      fileName: fileName,
      entries: parsed.entries,
      folderCount: parsed.folderCount,
      fileCount: parsed.fileCount,
      root: parsed.root,
      roots: parsed.roots || [],
      hasValidContent: parsed.hasValidContent,
      rawText: rawText,
    };
  }

  /** 无效分区的解析结果骨架（读取/解析失败时使用） */
  function invalidParsed() {
    return { entries: [], folderCount: 0, fileCount: 0, root: null, roots: [], hasValidContent: false };
  }

  /**
   * 把已解码文本解析为分区数组：
   *  - 本系统导出的合并 txt：按 TDM-MERGE-SOURCE 标记拆分，各片段独立解析，
   *    分区名取标记中的原始文件名（各条目的来源分区 / 硬盘归属得以完整还原）
   *  - 普通 txt：整档解析为单个分区
   * @param {string} text 已解码文本
   * @param {string} fallbackFileName 上传文件名（普通文件的分区名）
   * @returns {object[]} Partition[]
   */
  function buildPartitionsFromText(text, fallbackFileName) {
    const segments = TDM.parser.splitMergedText(text);
    if (segments === null) {
      return [makePartition(fallbackFileName, TDM.parser.parseTreeText(text, fallbackFileName), text)];
    }
    const parts = [];
    for (let i = 0; i < segments.length; i++) {
      parts.push(makePartition(
        segments[i].fileName,
        TDM.parser.parseTreeText(segments[i].text, segments[i].fileName),
        segments[i].text
      ));
    }
    return parts;
  }

  /**
   * 读取单个 File：readAsArrayBuffer → 编码探测解码 → 解析为分区数组
   * （合并 txt 会拆分为多个分区）。任何一步失败都降级为单个"无效分区"，
   * 绝不 reject（不中断整体解析）。
   * @param {File} file
   * @returns {Promise<object[]>} Promise<Partition[]>
   */
  function parseOneFile(file) {
    return new Promise(function (resolve) {
      const reader = new FileReader();
      reader.onload = function () {
        let parts;
        try {
          const decoded = TDM.parser.detectAndDecode(reader.result);
          parts = buildPartitionsFromText(decoded.text, file.name);
        } catch (e) {
          // 解析意外异常：按无效分区处理
          parts = [makePartition(file.name, invalidParsed(), '')];
        }
        resolve(parts);
      };
      reader.onerror = function () {
        // 读取失败：按无效分区处理
        resolve([makePartition(file.name, invalidParsed(), '')]);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ---------- 对外契约 ---------- */

  /**
   * 上传并解析文件，按来源 txt 文件名覆盖式并入指定侧，返回该侧最新统计。
   * 支持本系统导出的合并 txt：自动拆分回各来源分区后逐个并入。
   * @param {'mobile' | 'remote'} sideKey
   * @param {File[]} files
   * @returns {Promise<object>} Promise<SideStats>
   */
  function addFiles(sideKey, files) {
    return new Promise(function (resolve, reject) {
      const side = getSide(sideKey);
      if (!side) {
        reject(new Error('未知的数据库侧：' + sideKey));
        return;
      }

      // 兜底过滤：仅接受 .txt（UI 层已过滤，此处防御）
      const txtFiles = [];
      const list = files || [];
      for (let i = 0; i < list.length; i++) {
        if (list[i].name.toLowerCase().endsWith('.txt')) txtFiles.push(list[i]);
      }

      // 逐文件串行处理，避免大文件并发读取的内存峰值
      let idx = 0;
      function next() {
        if (idx >= txtFiles.length) {
          recomputeSide(side);
          invalidateDiff(); // 数据已变更，已有差异结果过期
          resolve(side.stats);
          return;
        }
        const file = txtFiles[idx++];
        parseOneFile(file).then(function (parts) {
          // 逐分区并入：同名分区覆盖旧数据（Map.set 覆盖并保持原插入位置）；
          // 合并 txt 拆分出的分区同样按其原始文件名并入
          for (let i = 0; i < parts.length; i++) {
            side.partitionMap.set(parts[i].fileName, parts[i]);
          }
          next();
        });
      }
      next();
    });
  }

  /**
   * 清空指定侧数据
   * @param {'mobile' | 'remote'} sideKey
   */
  function resetSide(sideKey) {
    const side = getSide(sideKey);
    if (!side) return;
    side.partitionMap.clear();
    side.entries = [];
    side.nameSet = new Set();
    side.stats = null;
    side.tree = null;
    side.treeDirty = true;
    invalidateDiff(); // 数据已变更，已有差异结果过期
  }

  /**
   * 获取指定侧统计（null 表示尚未上传）
   * @param {'mobile' | 'remote'} sideKey
   * @returns {object | null} SideStats
   */
  function getStats(sideKey) {
    const side = getSide(sideKey);
    return side ? side.stats : null;
  }

  /**
   * 获取指定侧的分区明细（只读视图，供 UI 渲染分区清单）
   * @param {'mobile' | 'remote'} sideKey
   * @returns {object[]} Partition[]
   */
  function getPartitions(sideKey) {
    const side = getSide(sideKey);
    if (!side) return [];
    return Array.from(side.partitionMap.values());
  }

  /**
   * 两侧是否均含有效条目（各自独立判断）
   * @returns {{ mobile: boolean, remote: boolean }}
   */
  function isReady() {
    return {
      mobile: sides.mobile.entries.length > 0,
      remote: sides.remote.entries.length > 0,
    };
  }

  /**
   * 获取最近一次差异分析结果（含 stale 标记），无结果返回 null
   * @returns {object | null} DiffResults
   */
  function getDiff() {
    return diffCache;
  }

  /* ---------- 模糊查找（plan.md R6：线性包含匹配，无需索引） ---------- */

  /**
   * 按关键词在两库全部条目中做归一化包含匹配。
   * 归一化口径：trim + toLowerCase（与差异分析一致，跨文件/文件夹类型）。
   *  - 空白关键词返回 null（UI 不渲染）
   *  - 单侧未上传时该侧返回空数组（UI 降级标注）
   * @param {string} keyword 用户输入
   * @returns {{ keyword: string, mobile: object[], remote: object[] } | null}
   */
  function search(keyword) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (kw.length === 0) return null;

    const mobile = [];
    const remote = [];
    let i;
    let e;

    // 扫描移动库
    const mEntries = sides.mobile.entries;
    for (i = 0; i < mEntries.length; i++) {
      e = mEntries[i];
      if (e.norm.indexOf(kw) >= 0) mobile.push(e);
    }
    // 扫描异地库
    const rEntries = sides.remote.entries;
    for (i = 0; i < rEntries.length; i++) {
      e = rEntries[i];
      if (e.norm.indexOf(kw) >= 0) remote.push(e);
    }

    return { keyword: kw, mobile: mobile, remote: remote };
  }

  /* ---------- 差异分析（plan.md R4/R7：按名称的库级集合比较） ---------- */

  /**
   * 按名称比较两库，产出"仅移动库有 / 仅异地库有"条目与汇总计数。
   *
   * 比较口径（已与用户确认）：
   *  - 名称归一化 = trim + toLowerCase
   *  - 名称在对方库任意位置出现过（不区分文件/文件夹类型）即视为两边共有
   *  - 独有名称的全部出现位置均列入结果
   *
   * 任一侧未就绪（无有效条目）返回 null。
   * @returns {{ mobileOnly: object[], remoteOnly: object[], commonNameCount: number,
   *             mobileOnlyNameCount: number, remoteOnlyNameCount: number, stale: boolean } | null}
   */
  function computeDiff() {
    const mobileSide = sides.mobile;
    const remoteSide = sides.remote;
    // 任一侧无有效条目：不具备比较条件
    if (mobileSide.entries.length === 0 || remoteSide.entries.length === 0) return null;

    const remoteNames = remoteSide.nameSet;
    const mobileNames = mobileSide.nameSet;

    // 仅移动库有：归一化名称不在异地库名称集合中的全部条目
    const mobileOnly = [];
    const mobileOnlyNames = new Set();
    for (let i = 0; i < mobileSide.entries.length; i++) {
      const e = mobileSide.entries[i];
      if (!remoteNames.has(e.norm)) {
        mobileOnly.push(e);
        mobileOnlyNames.add(e.norm);
      }
    }

    // 仅异地库有：同理
    const remoteOnly = [];
    const remoteOnlyNames = new Set();
    for (let i = 0; i < remoteSide.entries.length; i++) {
      const e = remoteSide.entries[i];
      if (!mobileNames.has(e.norm)) {
        remoteOnly.push(e);
        remoteOnlyNames.add(e.norm);
      }
    }

    // 两库共有名称数（遍历较小集合）
    let commonNameCount = 0;
    const smallSet = mobileNames.size <= remoteNames.size ? mobileNames : remoteNames;
    const bigSet = smallSet === mobileNames ? remoteNames : mobileNames;
    smallSet.forEach(function (n) {
      if (bigSet.has(n)) commonNameCount++;
    });

    const result = {
      mobileOnly: mobileOnly,
      remoteOnly: remoteOnly,
      commonNameCount: commonNameCount,
      mobileOnlyNameCount: mobileOnlyNames.size,
      remoteOnlyNameCount: remoteOnlyNames.size,
      stale: false,
    };
    diffCache = result; // 缓存以支撑 stale 过期提示
    return result;
  }

  /* ---------- 虚拟目录树（基于展平条目映射的层级结构，惰性构建） ---------- */

  /**
   * 拼接父子路径（与 parser 口径一致：父路径以 \ 结尾时不重复加分隔符）
   * @param {string} parentPath
   * @param {string} name
   * @returns {string}
   */
  function treeJoinPath(parentPath, name) {
    const sep = parentPath.charAt(parentPath.length - 1) === '\\' ? '' : '\\';
    return parentPath + sep + name;
  }

  /**
   * 把一个分区的展平条目映射为目录树。
   * 节点带 parent 引用与直接子项计数；nodes 以完整路径为键，
   * 供查找/差异结果跳转时 O(1) 定位。
   * @param {object} p Partition
   * @returns {{ partition: string, root: string | null, rootNode: object | null,
   *             nodes: Map, entryCount: number }}
   */
  function buildPartitionTree(p) {
    const tree = {
      partition: p.fileName,
      root: p.root,
      rootNode: null,
      nodes: new Map(),
      entryCount: p.entries.length,
    };
    if (!p.root) return tree; // 未识别出根路径的分区无可浏览结构

    const rootNode = {
      name: p.root,
      type: 'folder',
      path: p.root,
      partition: p.fileName,
      parent: null,
      children: new Map(),
      folderCount: 0,
      fileCount: 0,
    };
    tree.rootNode = rootNode;
    tree.nodes.set(p.root, rootNode);

    const rootLen = p.root.length;
    for (let i = 0; i < p.entries.length; i++) {
      const entry = p.entries[i];
      if (entry.path.indexOf(p.root) !== 0) continue; // 防御：不在根下的条目不进树
      const segs = entry.path.slice(rootLen).split('\\');
      // 逐段确保父链存在（tree 输出父先于子，通常直接命中节点缓存）
      let cur = rootNode;
      for (let j = 0; j < segs.length - 1; j++) {
        const seg = segs[j];
        if (seg.length === 0) continue;
        const segPath = treeJoinPath(cur.path, seg);
        let node = tree.nodes.get(segPath);
        if (node === undefined) {
          node = {
            name: seg,
            type: 'folder',
            path: segPath,
            partition: p.fileName,
            parent: cur,
            children: new Map(),
            folderCount: 0,
            fileCount: 0,
          };
          tree.nodes.set(segPath, node);
          cur.children.set(seg, node);
          cur.folderCount++;
        }
        cur = node;
      }
      const lastName = segs[segs.length - 1];
      if (lastName.length === 0) continue;
      if (entry.type === 'folder') {
        if (tree.nodes.get(entry.path) === undefined) {
          const node = {
            name: lastName,
            type: 'folder',
            path: entry.path,
            partition: p.fileName,
            parent: cur,
            children: new Map(),
            folderCount: 0,
            fileCount: 0,
          };
          tree.nodes.set(entry.path, node);
          cur.children.set(lastName, node);
          cur.folderCount++;
        }
      } else {
        if (!cur.children.has(lastName)) {
          const node = {
            name: lastName,
            type: 'file',
            path: entry.path,
            partition: p.fileName,
            parent: cur,
            children: null,
            folderCount: 0,
            fileCount: 0,
          };
          tree.nodes.set(entry.path, node);
          cur.children.set(lastName, node);
          cur.fileCount++;
        }
      }
    }
    return tree;
  }

  /**
   * 获取指定侧的虚拟目录树（惰性构建 + 缓存；数据变更后下次调用自动重建）。
   * @param {string} sideKey
   * @returns {{ partitions: object[] } | null} 未知侧返回 null
   */
  function getSideTree(sideKey) {
    const side = getSide(sideKey);
    if (!side) return null;
    if (side.tree === null || side.treeDirty) {
      const partitions = [];
      side.partitionMap.forEach(function (p) {
        partitions.push(buildPartitionTree(p));
      });
      side.tree = { partitions: partitions };
      side.treeDirty = false;
    }
    return side.tree;
  }

  /* ---------- 挂载 ---------- */
  core.addFiles = addFiles;
  core.resetSide = resetSide;
  core.getStats = getStats;
  core.getPartitions = getPartitions;
  core.isReady = isReady;
  core.getDiff = getDiff;
  core.search = search;
  core.computeDiff = computeDiff;
  core.getSideTree = getSideTree;
})();

/**
 * TDM.parser - 编码探测与 tree /F 文本解析
 *
 * 职责：
 *  1. detectAndDecode: 三级编码探测（UTF-8 BOM → 严格 UTF-8 → GBK 容错回退）
 *  2. parseTreeText:   栈式缩进宽度算法解析 Windows tree /F 输出
 *  3. splitMergedText: 识别本系统导出的合并 txt，按 TDM-MERGE-SOURCE 标记拆分回各分区
 *
 * 解析算法要点（plan.md R1，已对真实数据码点级验证）：
 *  - 缩进块宽度非均匀：竖线块 `│  `（3 字符），空格块 4 字符
 *  - 文件夹行前缀（├─/└─ 之前）仅由 │(U+2502) 与空格组成
 *  - 文件行：剥离行首 [ │]+ 后剩余非空
 *  - 文件行先于子文件夹行；分隔空行跳过；卷头部行与根路径行特殊处理
 *  - 维护祖先栈 { width, name, path }：pop 所有 width >= 当前的栈项后挂到栈顶
 */
(function () {
  'use strict';

  const TDM = (window.TDM = window.TDM || {});
  const parser = (TDM.parser = TDM.parser || {});

  /* ============================================================
   * 编码探测与解码（plan.md R2）
   * ============================================================ */

  /**
   * 探测 ArrayBuffer 的文本编码并解码。
   * 三级策略：
   *  ① 前 3 字节为 EF BB BF → UTF-8（带 BOM）
   *  ② 严格 UTF-8 解码（fatal: true）成功 → UTF-8
   *  ③ 严格解码抛错 → GBK 容错解码（无效字节替换为替代符，永不抛错）
   * @param {ArrayBuffer} buffer
   * @returns {{ text: string, encoding: 'utf-8' | 'gbk' }}
   */
  function detectAndDecode(buffer) {
    const bytes = new Uint8Array(buffer);

    // ① UTF-8 BOM 检测
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      // TextDecoder 默认会剥离 BOM，此处再兜底移除一次
      const text = new TextDecoder('utf-8').decode(buffer).replace(/^\uFEFF/, '');
      return { text: text, encoding: 'utf-8' };
    }

    // ② 严格 UTF-8 尝试（纯 ASCII 文件也走此分支，结果正确）
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      return { text: text, encoding: 'utf-8' };
    } catch (e) {
      // ③ GBK 容错回退（Chromium 原生支持；无效字节以替代符呈现）
      const text = new TextDecoder('gbk').decode(buffer);
      return { text: text, encoding: 'gbk' };
    }
  }

  /* ============================================================
   * tree /F 文本解析（plan.md R1：栈式缩进宽度解析）
   * ============================================================ */

  // 根路径行：如 F:\ 或 G:
  const ROOT_RE = /^[A-Za-z]:\\?$/;
  // 卷头部噪声行（多盘拼接的内容中，后续盘的卷头会出现在根行之后，需跳过避免误记为文件）
  const VOLUME_HEADER_RE = /^卷 .+ 的文件夹 PATH 列表$/;
  const VOLUME_SERIAL_RE = /^卷序列号为 .+$/;
  // 制表符相关字符
  const CHAR_BAR = '│';        // U+2502
  const CHAR_TEES = ['├', '└']; // U+251C / U+2514
  const CHAR_DASH = '─';        // U+2500
  // 文件行行首剥离模式：连续的 │ 与空格
  const LEADING_PREFIX_RE = /^[│ ]+/;

  /**
   * 在一行中定位文件夹标记（├─ 或 └─）。
   * 取第一个"其前缀仅含 │ 与空格"的 ├/└（后跟 ─）出现处，
   * 以兼容文件夹名中含 ─ 等同形字符的情况。
   * @param {string} line
   * @returns {{ width: number, name: string } | null} width = 标记前缀宽度
   */
  function findFolderMarker(line) {
    for (let i = 0; i < line.length - 1; i++) {
      const ch = line.charAt(i);
      if (ch !== CHAR_TEES[0] && ch !== CHAR_TEES[1]) continue;
      if (line.charAt(i + 1) !== CHAR_DASH) continue;
      // 校验前缀 [0, i)：仅允许 │ 与空格
      let prefixOk = true;
      for (let j = 0; j < i; j++) {
        const cj = line.charAt(j);
        if (cj !== CHAR_BAR && cj !== ' ') { prefixOk = false; break; }
      }
      if (!prefixOk) continue;
      return { width: i, name: line.slice(i + 2).trim() };
    }
    return null;
  }

  /**
   * 拼接父子路径（根路径已以 \ 结尾时不重复加分隔符）
   * @param {string} parentPath
   * @param {string} name
   * @returns {string}
   */
  function joinPath(parentPath, name) {
    const sep = parentPath.charAt(parentPath.length - 1) === '\\' ? '' : '\\';
    return parentPath + sep + name;
  }

  /**
   * 解析 tree /F 文本为一个分区的条目清单。
   *
   * 行分类（按序判定）：
   *  1. 根路径行 ^[A-Za-z]:\\?$ → 重置祖先栈（首个根行之前的内容全部跳过）
   *  2. 卷头部噪声行（卷 … 的文件夹 PATH 列表 / 卷序列号 …）→ 跳过
   *  3. 文件夹行：存在合法 ├─/└─ 标记 → 栈算法归位并入栈
   *  4. 文件行：剥离行首 [ │]+ 后有剩余 → 归属当前栈顶
   *  5. 分隔空行 / 其他 → 跳过
   *
   * @param {string} text 已解码的 tree 文本
   * @param {string} partitionFileName 来源 txt 文件名（写入每个条目）
   * @returns {{ entries: Array, folderCount: number, fileCount: number,
   *             root: string | null, roots: string[], hasValidContent: boolean }}
   */
  function parseTreeText(text, partitionFileName) {
    const entries = [];
    let folderCount = 0;
    let fileCount = 0;
    let root = null;
    const roots = []; // 出现过的全部根路径（去重；单盘文件恒为 1 个）

    // 祖先栈：每项 { width, name, path }；栈底为根项（width = -1）
    const stack = [];

    const lines = text.split('\n');
    for (let li = 0; li < lines.length; li++) {
      let line = lines[li];
      // 统一处理 \r\n 换行：去掉行尾 \r
      if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
        line = line.slice(0, -1);
      }
      if (line.length === 0) continue; // 纯空行

      // --- 1. 根路径行：重置栈 ---
      if (ROOT_RE.test(line)) {
        root = line;
        if (roots.indexOf(line) < 0) roots.push(line);
        stack.length = 0;
        stack.push({ width: -1, name: root, path: root });
        continue;
      }

      // --- 2. 卷头部噪声行：跳过（多盘拼接时后续盘的卷头不可记为文件） ---
      if (VOLUME_HEADER_RE.test(line) || VOLUME_SERIAL_RE.test(line)) continue;

      // 首个根行之前的内容（卷标题行、卷序列号行等头部）全部跳过
      if (stack.length === 0) continue;

      // --- 3. 文件夹行 ---
      const marker = findFolderMarker(line);
      if (marker !== null) {
        const name = marker.name;
        if (name.length === 0) continue; // 名称为空的文件夹行跳过
        // pop 所有宽度 >= 当前宽度的栈项（保留栈底根项）
        while (stack.length > 1 && stack[stack.length - 1].width >= marker.width) {
          stack.pop();
        }
        const parent = stack[stack.length - 1];
        const path = joinPath(parent.path, name);
        stack.push({ width: marker.width, name: name, path: path });
        entries.push({
          name: name,
          norm: name.toLowerCase(),
          type: 'folder',
          path: path,
          partition: partitionFileName,
        });
        folderCount++;
        continue;
      }

      // --- 4. 文件行 / 分隔空行 ---
      const stripped = line.replace(LEADING_PREFIX_RE, '');
      if (stripped.length === 0) continue; // 分隔空行（如 `    │  │      `）
      const name = stripped.trim();
      if (name.length === 0) continue; // 纯空白名称忽略
      const parent = stack[stack.length - 1];
      const path = joinPath(parent.path, name);
      entries.push({
        name: name,
        norm: name.toLowerCase(),
        type: 'file',
        path: path,
        partition: partitionFileName,
      });
      fileCount++;
    }

    return {
      entries: entries,
      folderCount: folderCount,
      fileCount: fileCount,
      root: root,
      roots: roots,
      hasValidContent: entries.length > 0,
    };
  }

  /* ============================================================
   * 合并文件拆分（本系统导出的合并 txt）
   * ============================================================ */

  // 来源分区标记行：========== TDM-MERGE-SOURCE: <原始文件名> ==========
  // tree 输出的内容行不可能顶格出现 "=========="（文件夹行带 ├─/└─ 前缀，
  // 文件行必有缩进，根路径行为盘符，卷头行以"卷"开头），标记不会与真实内容冲突。
  const MERGE_SOURCE_RE = /^========== TDM-MERGE-SOURCE: (.+?) ==========\s*$/;

  /**
   * 识别并拆分本系统导出的合并 txt。
   * @param {string} text 已解码文本
   * @returns {{ fileName: string, text: string }[] | null} 各来源分区片段；非合并文件返回 null
   */
  function splitMergedText(text) {
    const lines = String(text || '').split('\n');
    const segments = [];
    let current = null;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
        line = line.slice(0, -1);
      }
      const m = MERGE_SOURCE_RE.exec(line);
      if (m !== null && m[1].trim().length > 0) {
        if (current !== null) segments.push(current);
        current = { fileName: m[1].trim(), lines: [] };
        continue;
      }
      if (current !== null) current.lines.push(line); // 首个标记之前的内容（文件头）丢弃
    }
    if (current !== null) segments.push(current);
    if (segments.length === 0) return null;
    const out = [];
    for (let i = 0; i < segments.length; i++) {
      out.push({ fileName: segments[i].fileName, text: segments[i].lines.join('\n') });
    }
    return out;
  }

  // 挂载到命名空间
  parser.detectAndDecode = detectAndDecode;
  parser.parseTreeText = parseTreeText;
  parser.splitMergedText = splitMergedText;
})();

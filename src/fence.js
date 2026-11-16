/**
 * URI 围栏:本扩展唯一允许触达的 OpenViking 位置。
 *
 * 只放行一棵子树 `viking://user/default/memories`(读和写同一棵)。其他任何 URI ——
 * 包括 `viking://resources`、`viking://~/resources`、`viking://user/<别人>/...` ——
 * 在发出 HTTP 请求之前就被拒掉,不会「先写再检查」。
 */

/** 唯一允许的根。读写同一棵子树。 */
export const MEMORY_ROOT = 'viking://user/default/memories';

/** `viking://~/x` 是 `viking://user/default/x` 的别名;不展开就会被前缀检查绕过。 */
const USER_ROOT = 'viking://user/default/';

/** 围栏拒绝;调用方转成 failed 回执。 */
export class FenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FenceError';
  }
}

/**
 * 把外部传入的 URI 规范成绝对形式,并拒绝一切可疑形态。
 * 抛 FenceError 表示该 URI 连规范化都不给过。
 */
export function normalizeUri(input) {
  if (typeof input !== 'string') throw new FenceError('URI 必须是字符串');
  const raw = input.trim();
  if (!raw) throw new FenceError('URI 不能为空');
  // 反斜杠、空白、query:避免拼接歧义,也避免下游把它当分隔符。
  // `#` 单独放行:它是 Windows 合法的文件名字符,存量里确有这种条目(占位符那条就带 `#`),
  // 而本插件把它当请求参数发送(URLSearchParams / JSON body),不会退化成 fragment。
  // 写入侧(safeLeafName / safeSubdir)仍然拒绝 `#`,读旧名宽容、写新名严格。
  if (/[\\\s?]/.test(raw)) throw new FenceError(`URI 含非法字符: ${JSON.stringify(raw)}`);
  // 百分号编码的 . / \ 一旦被下游解码就会越过前缀检查。
  if (/%2e|%2f|%5c/i.test(raw)) throw new FenceError(`URI 含百分号编码的路径分隔符: ${raw}`);

  let uri = raw.replace(/\/+$/, '');
  // 别名展开必须发生在任何比较之前。
  if (uri === 'viking://~') uri = 'viking://user/default';
  else if (uri.startsWith('viking://~/')) uri = USER_ROOT + uri.slice('viking://~/'.length);

  if (!uri.startsWith('viking://')) throw new FenceError(`URI 必须以 viking:// 开头: ${raw}`);
  if (uri.slice('viking://'.length).split('/').includes('..')) {
    throw new FenceError(`URI 不能包含 .. 段: ${raw}`);
  }
  return uri;
}

/** uri 是否等于 root 或位在其下(按段比较,`memoriesX` 不算)。 */
export function isUnder(uri, root) {
  return uri === root || uri.startsWith(`${root}/`);
}

/** 读路径的围栏:只有 MEMORY_ROOT 子树。 */
export function assertReadable(input) {
  const uri = normalizeUri(input);
  if (!isUnder(uri, MEMORY_ROOT)) {
    throw new FenceError(
      `拒绝读取 ${uri}:本扩展只读 ${MEMORY_ROOT} 子树。viking://resources 等位置不在允许范围内。`,
    );
  }
  return uri;
}

/** 写路径的围栏:与读同一棵子树,此外无第二本书、无子根。 */
export function assertWritable(input) {
  const uri = normalizeUri(input);
  if (!isUnder(uri, MEMORY_ROOT)) {
    throw new FenceError(
      `拒绝写入 ${uri}:本扩展只写 ${MEMORY_ROOT} 子树,且不得触碰 viking://resources 或 Coopanion 自己的 Memory。`,
    );
  }
  // 占位符只能待在正文里。任何写入路径都不准把它带进路径段 —— 一旦落成文件名,
  // 后续按名字检索、人工翻阅都会撞上一个不可读的串。
  if (hasPlaceholder(uri.slice('viking://'.length))) {
    throw new FenceError(
      `拒绝写入 ${uri}:路径里不能出现 {{...}} 占位符。占位符只放正文;文件名请给可读的名字。`,
    );
  }
  return uri;
}

/** `{{...}}` 形式的宿主占位符;只认成对的花括号,避免误伤正文里的单个 { }。 */
const PLACEHOLDER_RE = /\{\{[^{}]*\}\}/g;

/** 这段文字里有没有占位符语法。 */
export function hasPlaceholder(text) {
  return /\{\{[^{}]*\}\}/.test(String(text ?? ''));
}

/** 去掉占位符,留下周围的普通文字。 */
export function stripPlaceholders(text) {
  return String(text ?? '').replace(PLACEHOLDER_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 把模型给的名字收成单个文件名段。
 * 名字里带 `/`、`..`、控制字符的一律拒绝,而不是悄悄改成别的路径;
 * 带 `{{...}}` 占位符的则先把占位符摘掉 —— 文件名永远不该是一串占位符。
 */
export function safeLeafName(name) {
  if (typeof name !== 'string') throw new FenceError('name 必须是字符串');
  const leaf = stripPlaceholders(name.trim());
  if (!leaf) throw new FenceError(`name 去掉占位符后为空:${JSON.stringify(name)}`);
  if (/[/\\]/.test(leaf) || leaf.includes('..')) {
    throw new FenceError(`name 只能是单个文件名,不能含路径: ${JSON.stringify(name)}`);
  }
  if (/^[.\s]|[\u0000-\u001f]/.test(leaf)) throw new FenceError(`name 不能以点或空白开头: ${JSON.stringify(name)}`);
  return leaf.endsWith('.md') ? leaf : `${leaf}.md`;
}

/**
 * 分类目录:接受 `events/2026/11/13`、`events/2026/11/13/` 这样的相对目录。
 * 每一段都按文件名同级的规则验(不许 `.`/`..`、不许反斜杠、不许控制字符、不许占位符),
 * 返回 `a/b/c` 形式;空输入返回空串,表示「和以前一样落在 MEMORY_ROOT 根上」。
 */
export function safeSubdir(input) {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') throw new FenceError('dir 必须是字符串');
  const raw = input.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!raw) return '';
  if (/[\\\s?#]/.test(raw)) throw new FenceError(`dir 含非法字符: ${JSON.stringify(input)}`);
  if (/%2e|%2f|%5c/i.test(raw)) throw new FenceError(`dir 含百分号编码的路径分隔符: ${raw}`);
  const segments = raw.split('/');
  for (const segment of segments) {
    if (!segment) throw new FenceError(`dir 里有空目录名: ${JSON.stringify(input)}`);
    if (segment === '.' || segment === '..') throw new FenceError(`dir 不能包含 . 或 .. 段: ${JSON.stringify(input)}`);
    if (segment.startsWith('.')) throw new FenceError(`dir 段不能以点开头(隐藏目录不给用): ${JSON.stringify(input)}`);
    if (/[\u0000-\u001f]/.test(segment)) throw new FenceError(`dir 段含控制字符: ${JSON.stringify(input)}`);
    if (hasPlaceholder(segment)) throw new FenceError(`dir 段不能包含占位符: ${JSON.stringify(input)}`);
  }
  return segments.join('/');
}

/** 用一段可读标题拼出文件名,保留中文,去掉路径分隔符与占位符。 */
export function slugFromText(text) {
  const firstLine = String(text ?? '').split('\n')[0];
  // 先摘占位符再取标题:否则以占位符开头的内容会拼出一串不可读的名字。
  const head = stripPlaceholders(firstLine).replace(/^#+\s*/, '').trim();
  const base = head
    .slice(0, 40)
    .replace(/[/\\:*?"<>|{}#\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${base || 'note'}-${stamp}.md`;
}

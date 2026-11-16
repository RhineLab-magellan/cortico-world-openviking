/**
 * World 实例:把 OpenViking 的记忆库做成一套工具。
 *
 * 读:search / find / read / list / tree / grep / glob / health —— 全部落在 MEMORY_ROOT 子树。
 * 写:remember / write / edit / rename —— 同一棵子树。
 * 删:forget —— 可用,语义与服务自己的 `DELETE /api/v1/fs` 完全一致:永久删除,没有回收站。
 *
 * 三条硬约束(都在发出 HTTP 之前生效):
 * 1. 只碰 MEMORY_ROOT 这一棵子树。
 * 2. 写入路径里不许出现 `{{...}}` 占位符 —— 占位符只能待在正文。
 * 3. 列表类工具默认就有上限,截断时一定给出「继续往下看」的入口,不再静默吞掉。
 */
import { fileURLToPath } from 'node:url';
import { createClient, OpenVikingError } from './client.js';
import {
  FenceError, MEMORY_ROOT, assertReadable, assertWritable, hasPlaceholder, safeLeafName, safeSubdir,
  slugFromText, stripPlaceholders,
} from './fence.js';

/** 环境提示词模板的绝对路径。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

const EXCERPT_LIMIT = 600;

/** 列表类工具的默认上限与硬上限 —— 默认就封顶,是这次改动的要点。 */
const TREE_DEFAULT_ENTRIES = 60;
const TREE_MAX_ENTRIES = 400;
const TREE_DEFAULT_CHARS = 2400;
const TREE_MAX_CHARS = 8000;
const GLOB_DEFAULT_LIMIT = 50;
const GLOB_MAX_LIMIT = 200;
const GLOB_MAX_CHARS = 3000;

/** 改名前的备份落点(在围栏内)。 */
const BACKUP_ROOT = `${MEMORY_ROOT}/backups`;

/** 这些文件名意味着「某个席位的身份」,检索命中和读取时都要标出来。 */
const IDENTITY_LEAVES = new Set(['identity.md', 'soul.md', 'persona.md']);

/** 本扩展验证过的最低 OpenViking 版本;低于它时健康检查直接给升级提示。 */
const MIN_OPENVIKING_VERSION = '0.5.3';

/** 实测通过的版本(README 与市场说明里对齐)。 */
const TESTED_OPENVIKING_VERSIONS = ['0.5.3', '0.5.4', '0.5.4.1', '0.5.5'];

/** 把 "0.5.4.1" 切成数字段;拿不到数字的段按 0 算。 */
function versionParts(text) {
  return String(text ?? '')
    .split(/[.\-+]/)
    .map((piece) => {
      const n = Number.parseInt(piece, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** a<b 回负数,a>b 回正数,相等回 0。只比数字段,不引依赖。 */
function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function clamp(value, low, high) {
  const n = Number(value);
  if (!Number.isFinite(n)) return low;
  return Math.min(high, Math.max(low, Math.trunc(n)));
}

function truncate(text, limit = EXCERPT_LIMIT) {
  const flat = String(text ?? '').replace(/\r/g, '');
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…(共 ${flat.length} 字,已截断)`;
}

function failure(error) {
  if (error instanceof FenceError) return { text: error.message, failed: true };
  if (error instanceof OpenVikingError) return { text: error.message, failed: true };
  return { text: `调用失败:${error?.message ?? error}`, failed: true };
}

/** 只允许读出字符串正文。 */
function readText(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && typeof result.content === 'string') return result.content;
  return JSON.stringify(result ?? null);
}

/** `memories/a/b.md` → `a/b.md`;根下的文件返回文件名本身。 */
function relPath(uri) {
  const raw = String(uri ?? '');
  if (raw === MEMORY_ROOT) return '';
  return raw.startsWith(`${MEMORY_ROOT}/`) ? raw.slice(MEMORY_ROOT.length + 1) : raw;
}

/** 文件时间戳,用于备份目录名。 */
function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
}

export class OpenVikingWorld {
  constructor(options) {
    this.id = options.id;
    this.cfg = options.cfg;
    this.client = createClient({
      baseUrl: options.cfg.baseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.cfg.timeoutMs,
    });
    this.host = null;
    /** uri → 席位名;identity.md 的 Name 字段只在第一次读时抓一遍。 */
    this.seatCache = new Map();
  }

  /** 某条 URI 是否还存在(读得到就是存在)。 */
  async exists(uri) {
    try {
      await this.client.read({ uri, offset: 0, limit: 1 });
      return true;
    } catch {
      return false;
    }
  }

  /** 席位身份文件里的 `- **Name:** xxx`。读不到就返回空串,绝不因此让检索失败。 */
  async seatName(uri) {
    if (this.seatCache.has(uri)) return this.seatCache.get(uri);
    let name = '';
    try {
      const text = readText(await this.client.read({ uri, offset: 0, limit: 12 }));
      const found = text.match(/\*\*Name:\*\*\s*([^\n]{1,40})/);
      if (found) name = found[1].trim();
    } catch {
      name = '';
    }
    this.seatCache.set(uri, name);
    return name;
  }

  /**
   * 给一条检索命中标出来源。
   * 这是「不再把 identity.md 等他人条目当成当前身份记忆」的落地方式:
   * 身份文件明说是哪个席位的,普通条目则标出它来自哪个分类目录。
   */
  async sourceLabel(hit) {
    const uri = String(hit?.uri ?? '');
    const leaf = uri.slice(uri.lastIndexOf('/') + 1).toLowerCase();
    if (IDENTITY_LEAVES.has(leaf)) {
      const seat = await this.seatName(uri);
      return {
        kind: 'identity',
        text: `【席位身份:${seat || '未知席位'} —— 属于那个席位,不是当前身份的记忆】`,
      };
    }
    const rel = relPath(uri);
    const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '';
    const tags = Array.isArray(hit?.tags) ? hit.tags.map(String) : [];
    const tagType = tags.find((t) => t.startsWith('memory_type='));
    const category = tagType ? tagType.slice('memory_type='.length) : (top || '根级文件');
    return { kind: 'memory', text: `【来源:memories/${category}】` };
  }

  /** 前缀变量只报值;文案在 ENV_PROMPT.md 模板里。 */
  envPromptVars() {
    return {
      'openviking.baseUrl': this.cfg.baseUrl,
      'openviking.root': MEMORY_ROOT,
      'openviking.delete':
        '可用,语义与服务自己的 rm 一致:永久删除(正文与向量记录一起移除,没有回收站、没有软删除)',
    };
  }

  tools() {
    return [
      {
        name: 'ov_search',
        description:
          '在 OpenViking 记忆库里做语义检索。返回命中条目的 URI、分数、来源标注和摘要;'
          + '要正文再用 ov_read。这是第二套资料库,不是主记忆。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索问题或关键词。' },
            limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数,默认 8。' },
            target_uri: {
              type: 'string',
              description: `可选的检索范围,必须落在 ${MEMORY_ROOT} 之下;省略则查整棵子树。`,
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
        tags: ['read'],
        handler: async (args) => {
          try {
            const uri = assertReadable(args.target_uri ?? MEMORY_ROOT);
            const result = await this.client.search({
              query: String(args.query ?? ''),
              uri,
              limit: Number(args.limit ?? 8),
            });
            const hits = Array.isArray(result?.memories) ? result.memories : [];
            if (hits.length === 0) return `在 ${uri} 下没有命中。`;
            const labels = [];
            for (const hit of hits) labels.push(await this.sourceLabel(hit));
            const foreign = labels.filter((label) => label.kind === 'identity').length;
            const lines = hits.map((hit, i) => {
              const score = typeof hit.score === 'number' ? hit.score.toFixed(3) : '?';
              const abstract = truncate(hit.abstract ?? hit.overview ?? '', 300);
              return `${i + 1}. ${hit.uri} (score ${score}) ${labels[i].text}\n   ${abstract}`;
            });
            const warning = foreign
              ? `\n注意:命中里有 ${foreign} 条是别的席位的身份文件,不是你的记忆。`
              : '';
            return `在 ${uri} 下命中 ${hits.length} 条:${warning}\n${lines.join('\n')}`;
          } catch (error) {
            return failure(error);
          }
        },
      },
      {
        name: 'ov_find',
        description: '在 OpenViking 记忆库里按关键词找条目,不做语义扩展。返回 URI、来源标注与摘要。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词。' },
            limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数,默认 8。' },
            target_uri: { type: 'string', description: `可选范围,须在 ${MEMORY_ROOT} 之下。` },
          },
          required: ['query'],
          additionalProperties: false,
        },
        tags: ['read'],
        handler: async (args) => {
          try {
            const uri = assertReadable(args.target_uri ?? MEMORY_ROOT);
            const result = await this.client.find({
              query: String(args.query ?? ''),
              uri,
              limit: Number(args.limit ?? 8),
            });
            const hits = Array.isArray(result?.memories) ? result.memories : [];
            if (hits.length === 0) return `在 ${uri} 下没有命中。`;
            const lines = [];
            for (let i = 0; i < hits.length; i += 1) {
              const hit = hits[i];
              const label = await this.sourceLabel(hit);
              lines.push(`${i + 1}. ${hit.uri} ${label.text}\n   ${truncate(hit.abstract ?? '', 300)}`);
            }
            return `在 ${uri} 下命中 ${hits.length} 条:\n${lines.join('\n')}`;
          } catch (error) {
            return failure(error);
          }
        },
      },
      {
        name: 'ov_read',
        description: `按 URI 读 OpenViking 记忆条目的正文。URI 必须在 ${MEMORY_ROOT} 之下,例如 viking://user/default/memories/profile.md。`,
        parameters: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: '条目 URI。' },
            offset: { type: 'integer', minimum: 0, description: '起始行(0 起),默认 0。' },
            limit: { type: 'integer', description: '读多少行,-1 表示读到结尾,默认 120。' },
          },
          required: ['uri'],
          additionalProperties: false,
        },
        tags: ['read'],
        handler: async (args) => {
          try {
            const uri = assertReadable(args.uri);
            const result = await this.client.read({
              uri,
              offset: Number(args.offset ?? 0),
              limit: Number(args.limit ?? 120),
            });
            const label = await this.sourceLabel({ uri });
            const banner = label.kind === 'identity' ? `${label.text}\n` : '';
            return `【${uri}】\n${banner}${truncate(readText(result), 4000)}`;
          } catch (error) {
            return failure(error);
          }
        },
      },
      {
        name: 'ov_list',
        description: `列出 OpenViking 记忆库某目录下的条目。目录必须在 ${MEMORY_ROOT} 之下。`,
        parameters: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: `目录 URI,默认 ${MEMORY_ROOT}。` },
            recursive: { type: 'boolean', description: '是否递归,默认 false。' },
          },
          additionalProperties: false,
        },
        tags: ['read'],
        handler: async (args) => {
          try {
            const uri = assertReadable(args.uri ?? MEMORY_ROOT);
            const result = await this.client.list({ uri, recursive: Boolean(args.recursive) });
            const entries = Array.isArray(result) ? result : [];
            if (entries.length === 0) return `${uri} 是空的。`;
            const lines = entries
              .slice(0, 300)
              .map((e) => `${e.isDir ? '[dir] ' : '      '}${e.rel_path ?? e.name}`);
            const more = entries.length > 300 ? `\n…共 ${entries.length} 项,只列前 300。` : '';
            return `${uri} 下 ${entries.length} 项:\n${lines.join('\n')}${more}`;
          } catch (error) {
            return failure(error);
          }
        },
      },
      {
        name: 'ov_tree',
        description:
          `看 OpenViking 记忆库的目录树。根须在 ${MEMORY_ROOT} 之下。`
          + `默认只列 ${TREE_DEFAULT_ENTRIES} 条 / ${TREE_DEFAULT_CHARS} 字,超限时会给出继续分层的入口,不再整棵倾倒。`,
        parameters: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: `目录 URI,默认 ${MEMORY_ROOT}。` },
            level_limit: { type: 'integer', minimum: 1, maximum: 6, description: '深度,默认 2。' },
            max_entries: {
              type: 'integer',
              minimum: 1,
              maximum: TREE_MAX_ENTRIES,
              description: `最多列多少条,默认 ${TREE_DEFAULT_ENTRIES},上限 ${TREE_MAX_ENTRIES}。`,
            },
            max_chars: {
              type: 'integer',
              minimum: 200,
              maximum: TREE_MAX_CHARS,
              description: `最多打多少字,默认 ${TREE_DEFAULT_CHARS},上限 ${TREE_MAX_CHARS}。`,
            },
          },
          additionalProperties: false,
        },
        tags: ['read'],
        handler: async (args) => {
          try {
            const uri = assertReadable(args.uri ?? MEMORY_ROOT);
            const levels = clamp(args.level_limit ?? 2, 1, 6);
            const maxEntries = clamp(args.max_entries ?? TREE_DEFAULT_ENTRIES, 1, TREE_MAX_ENTRIES);
            const maxChars = clamp(args.max_chars ?? TREE_DEFAULT_CHARS, 200, TREE_MAX_CHARS);
            // 多要一条,才知道服务端还有没有后文。
            const entries = await this.client.tree({ uri, levelLimit: levels, nodeLimit: maxEntries + 1 });
            const list = Array.isArray(entries) ? entries : [];
            if (list.length === 0) return `${uri} 下没有条目。`;
            const hasMore = list.length > maxEntries;
            const shown = list.slice(0, maxEntries);
            const header = `${uri} 目录树(深度 ${levels};本次最多 ${maxEntries} 条 / ${maxChars} 字):`;
            const rows = shown.map((entry) => {
              const rel = String(entry.rel_path ?? entry.uri ?? '');
              const depth = Math.max(0, rel.split('/').length - 1);
              return `${'  '.repeat(depth)}${entry.isDir ? '[dir] ' : ''}${rel}`;
            });

            const kept = [];
            let used = header.length;
            for (const row of rows) {
              if (used + row.length + 1 > maxChars) break;
              kept.push(row);
              used += row.length + 1;
            }
            const cutByChars = kept.length < rows.length;
            const body = `${header}\n${kept.join('\n')}`;
            if (!cutByChars && !hasMore) return `${body}\n(共 ${list.length} 条,已全部列出。)`;

            const deepest = [...shown].reverse().find((entry) => entry.isDir) ?? null;
            const next = deepest?.uri ?? uri;
            const why = [
              cutByChars ? `${kept.length} 条已到 ${maxChars} 字上限` : '',
              hasMore ? `服务端还有更多(要了 ${maxEntries + 1} 条,拿到 ${list.length} 条)` : '',
            ].filter(Boolean).join(';');
            return [
              body,
              '',
              `…已截断:本次显示 ${kept.length} 条 / ${body.length} 字(${why})。`,
              '继续往下看:',
              `  - ov_tree uri=${next} level_limit=1   (只看这一层)`,
              `  - ov_list uri=${next}                 (列这个目录的直接子项)`,
              `  - 或调大 max_entries / max_chars 重来(上限 ${TREE_MAX_ENTRIES} 条 / ${TREE_MAX_CHARS} 字)`,
            ].join('\n');
          } catch (error) {
            return failure(error);
          }
        },
      },
      {
        name: 'ov_grep',
        description: '在 OpenViking 记忆库里按正则搜正文。范围必须落在允许的子树内。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '正则表达式。' },
            uri: { type: 'string', description: `搜索范围,默认 ${MEMORY_ROOT}。` },
            case_insensitive: { type: 'boolean', description: '忽略大小写,默认 false。' },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
        tags: ['read'],
        handler: async (args) => {
          try {
            const uri = assertReadable(args.uri ?? MEMORY_ROOT);
            const result = await this.client.grep({
              uri,
              pattern: String(args.pattern ?? ''),
              caseInsensitive: args.case_insensitive,
            });
            return truncate(readText(result), 4000);
          } catch (error) {
            return failure(error);
          }
        },
      },
      {
        name: 'ov_glob',
        description:
          `在 OpenViking 记忆库里按文件名通配符找条目。默认只列 ${GLOB_DEFAULT_LIMIT} 条`
          + `(上限 ${GLOB_MAX_LIMIT} 条 / ${GLOB_MAX_CHARS} 字),超限时给出收窄范围的办法。`,
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '通配符,如 **/*.md。' },
            uri: { type: 'string', description: `搜索范围,默认 ${MEMORY_ROOT}。` },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: GLOB_MAX_LIMIT,
              description: `最多列多少条,默认 ${GLOB_DEFAULT_LIMIT},上限 ${GLOB_MAX_LIMIT}。`,
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
        tags: ['read'],
        handler: async (args) => {
          try {
            const uri = assertReadable(args.uri ?? MEMORY_ROOT);
            const pattern = String(args.pattern ?? '');
            const limit = clamp(args.limit ?? GLOB_DEFAULT_LIMIT, 1, GLOB_MAX_LIMIT);
            const result = await this.client.glob({ pattern, uri, limit: limit + 1 });
            const matches = Array.isArray(result?.matches) ? result.matches : [];
            if (matches.length === 0) return `在 ${uri} 下没有匹配 ${pattern} 的条目。`;
            const reported = typeof result?.count === 'number' ? result.count : matches.length;
            const hasMore = matches.length > limit;
            const shown = matches.slice(0, limit);
            const header = `在 ${uri} 下 ${pattern} 命中 ${Math.max(reported, matches.length)} 条(本次最多列 ${limit} 条):`;
            const rows = [];
            for (let i = 0; i < shown.length; i += 1) rows.push(`${i + 1}. ${relPath(shown[i])}`);

            const kept = [];
            let used = header.length;
            for (const row of rows) {
              if (used + row.length + 1 > GLOB_MAX_CHARS) break;
              kept.push(row);
              used += row.length + 1;
            }
            const cutByChars = kept.length < rows.length;
            const body = `${header}\n${kept.join('\n')}`;
            if (!cutByChars && !hasMore) return `${body}\n(共 ${matches.length} 条,已全部列出。)`;
            return [
              body,
              '',
              `…已截断:本次显示 ${kept.length} 条 / ${body.length} 字`
                + `(${cutByChars ? `到 ${GLOB_MAX_CHARS} 字上限` : `共 ${Math.max(reported, matches.length)} 条`})。`,
              '继续往下看:',
              `  - 收窄 pattern(如 entities/**/*.md)或加 uri=viking://user/default/memories/<子目录>`,
              `  - 或调大 limit 重来(上限 ${GLOB_MAX_LIMIT} 条)`,
              '  - 找正文用 ov_search / ov_grep',
            ].join('\n');
          } catch (error) {
            return failure(error);
          }
        },
      },
      {
        name: 'ov_health',
        description:
          `查 OpenViking 服务是否在线,返回状态、版本与鉴权模式;`
          + `版本低于 ${MIN_OPENVIKING_VERSION} 时直接给出升级提示。`,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        tags: ['read'],
        handler: async () => {
          try {
            const info = await this.client.health();
            const payload = info && typeof info === 'object' ? info : {};
            const status = payload.status ?? (payload.healthy ? 'ok' : '未知');
            const version = typeof payload.version === 'string' && payload.version.trim() ? payload.version.trim() : '';
            const auth = payload.auth_mode ?? '服务未返回鉴权模式';
            const lines = [
              `OpenViking 在线:${status},版本 ${version || '服务未返回版本'},鉴权模式 ${auth},地址 ${this.cfg.baseUrl}`,
            ];
            if (!version) {
              lines.push(
                `本扩展需要 OpenViking ${MIN_OPENVIKING_VERSION} 或更高;服务没报版本,无法确认兼容性,请先确认服务版本。`,
              );
            } else if (compareVersions(version, MIN_OPENVIKING_VERSION) < 0) {
              lines.push(
                `版本过旧:本扩展需要 OpenViking ${MIN_OPENVIKING_VERSION} 或更高`
                + `(已验证 ${TESTED_OPENVIKING_VERSIONS.join(' / ')})。`
                + `当前是 ${version},检索与写入可能报错,请先升级 OpenViking。`,
              );
            }
            return lines.join('\n');
          } catch (error) {
            return failure(error);
          }
        },
      },
      {
        name: 'ov_remember',
        description:
          `把一段内容写成 OpenViking 记忆库里的一条新记忆(落在 ${MEMORY_ROOT} 之下,由服务端异步建索引)。`
          + '可以用 dir 指定分类目录(如 events/2026/11/13),不给就落在根上,和以前一样。'
          + '这是写回原版记忆库,不是另开一本书。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '要记住的正文(Markdown)。' },
            name: { type: 'string', description: '可选文件名(单个文件名,不含路径);省略则由首行自动生成。' },
            dir: {
              type: 'string',
              description: '可选分类目录(相对路径,如 events/2026/11/13 或 entities/项目);省略则落根。',
            },
          },
          required: ['content'],
          additionalProperties: false,
        },
        tags: ['write'],
        handler: async (args) => {
          try {
            const content = String(args.content ?? '');
            if (!content.trim()) return { text: '已拒绝:content 不能为空。', failed: true };
            const subdir = safeSubdir(args.dir);
            const leaf = args.name ? safeLeafName(args.name) : slugFromText(content);
            const base = subdir ? `${MEMORY_ROOT}/${subdir}` : MEMORY_ROOT;
            const uri = assertWritable(`${base}/${leaf}`);
            if (subdir) {
              // 目录可能还不存在;建目录失败不在这里报,写入本身会给出真实错误。
              await this.client.mkdir({ uri: base }).catch(() => {});
            }
            await this.client.write({ uri, content, mode: 'create' });
            const where = subdir ? `目录 ${subdir}` : '根目录';
            return `已写入 ${uri}(${content.length} 字,${where}),OpenViking 会在后台建索引。`;
          } catch (error) {
            return failure(error);
          }
        },
      },
      {
        name: 'ov_write',
        description:
          `按 URI 写入或覆盖 OpenViking 记忆库里的一条记忆。URI 必须在 ${MEMORY_ROOT} 之下;`
          + '指向 viking://resources 或任何其他位置的写入会被拒绝;路径里不许出现 {{...}} 占位符。',
        parameters: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: '目标 URI。' },
            content: { type: 'string', description: '完整正文。' },
            mode: {
              type: 'string',
              enum: ['replace', 'append', 'create'],
              description: '写入方式,默认 replace。',
            },
          },
          required: ['uri', 'content'],
          additionalProperties: false,
        },
        tags: ['write'],
        handler: async (args) => {
          try {
            const uri = assertWritable(args.uri);
            const mode = args.mode ?? 'replace';
            if (!['replace', 'append', 'create'].includes(mode)) {
              return { text: `已拒绝:mode 只能是 replace / append / create,收到 ${mode}。`, failed: true };
            }
            const content = String(args.content ?? '');
            await this.client.write({ uri, content, mode });
            return `已写入 ${uri}(${content.length} 字,mode=${mode})。`;
          } catch (error) {
            return failure(error);
          }
        },
      },
      {
        name: 'ov_edit',
        description:
          '改 OpenViking 记忆库里已有条目的一段文字:先读到当前正文,把 old_text 换成 new_text,再写回。'
          + 'old_text 必须在该条目里唯一出现;URI 必须在允许的子树内。',
        parameters: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: '要改的条目 URI。' },
            old_text: { type: 'string', description: '要被替换的原文,须唯一匹配。' },
            new_text: { type: 'string', description: '替换后的文字。' },
          },
          required: ['uri', 'old_text', 'new_text'],
          additionalProperties: false,
        },
        tags: ['write'],
        handler: async (args) => {
          try {
            const uri = assertWritable(args.uri);
            const oldText = String(args.old_text ?? '');
            if (!oldText) return { text: '已拒绝:old_text 不能为空。', failed: true };
            const current = readText(await this.client.read({ uri, offset: 0, limit: -1 }));
            const first = current.indexOf(oldText);
            if (first < 0) return { text: `没有改动:${uri} 里找不到 old_text。`, failed: true };
            if (current.indexOf(oldText, first + oldText.length) >= 0) {
              return { text: `没有改动:old_text 在 ${uri} 里出现多次,无法定位唯一一处。`, failed: true };
            }
            const next = current.slice(0, first) + String(args.new_text ?? '') + current.slice(first + oldText.length);
            await this.client.write({ uri, content: next, mode: 'replace' });
            return `已改 ${uri}(${oldText.length} 字 → ${String(args.new_text ?? '').length} 字)。`;
          } catch (error) {
            return failure(error);
          }
        },
      },
      {
        name: 'ov_rename',
        description:
          '把存量条目的文件名改掉:先把正文备份到 memories/backups/rename-<时间戳>/,'
          + '再用 OpenViking 自己的 mv 改名,正文一个字节都不动(占位符仍留在正文里)。'
          + '名为 {{...}} 的旧条目就是靠它救回来的;目标名已存在时拒绝,不覆盖。',
        parameters: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: '要改名的条目 URI(可以带占位符 —— 这是唯一允许读它的地方)。' },
            new_name: {
              type: 'string',
              description: '新文件名。省略则由旧名去掉占位符后自动拼;新名里出现占位符会被剥掉。',
            },
          },
          required: ['uri'],
          additionalProperties: false,
        },
        tags: ['write'],
        handler: async (args) => {
          try {
            const from = assertReadable(args.uri);
            if (from === MEMORY_ROOT) return { text: '已拒绝:不能给根目录改名。', failed: true };
            const slash = from.lastIndexOf('/');
            const parent = from.slice(0, slash);
            const currentLeaf = from.slice(slash + 1);

            let leaf;
            if (args.new_name) {
              leaf = safeLeafName(args.new_name);
            } else {
              const stem = currentLeaf.replace(/\.md$/i, '');
              const cleaned = stripPlaceholders(stem)
                .replace(/[^0-9A-Za-z\u4e00-\u9fa5._-]+/g, '-')
                .replace(/^-+|-+$/g, '');
              leaf = safeLeafName(cleaned || `memory-${stamp()}`);
            }
            if (leaf === currentLeaf) {
              return { text: `没有改动:${from} 的文件名已经是 ${leaf}。`, failed: false };
            }

            const to = assertWritable(`${parent}/${leaf}`);
            if (await this.exists(to)) {
              return { text: `已拒绝改名:目标 ${to} 已经存在,不覆盖别人的条目。`, failed: true };
            }

            const content = readText(await this.client.read({ uri: from, offset: 0, limit: -1 }));
            const backupDir = `${BACKUP_ROOT}/rename-${stamp()}`;
            const backupUri = assertWritable(`${backupDir}/${leaf.replace(/\.md$/i, '')}-backup.md`);
            await this.client.mkdir({ uri: backupDir }).catch(() => {});
            const backupBody =
              `<!-- 改名备份:${from} → ${to} @ ${new Date().toISOString()} -->\n\n${content}`;
            await this.client.write({ uri: backupUri, content: backupBody, mode: 'create' });

            // 备份读回校验:备份没落地就不许改名。
            const backupBack = readText(await this.client.read({ uri: backupUri, offset: 0, limit: -1 }));
            const probe = content.slice(0, Math.min(60, content.length));
            if (probe && !backupBack.includes(probe)) {
              return { text: `已停止:备份 ${backupUri} 读回与原文不一致,没有改名。`, failed: true };
            }

            await this.client.move({ fromUri: from, toUri: to });

            const after = readText(await this.client.read({ uri: to, offset: 0, limit: -1 }));
            const sameBody = after.trim() === content.trim();
            const placeholderKept = hasPlaceholder(after);
            const oldGone = !(await this.exists(from));
            return [
              `已改名:${from}`,
              `      → ${to}`,
              `备份:${backupUri}(${backupBody.length} 字,读回校验通过)`,
              `正文:${after.length} 字,与原文${sameBody ? '逐字一致' : '不一致(请复核)'};`
                + `占位符${placeholderKept ? '仍保留在正文里' : '已不在正文里'}`,
              `旧路径:${oldGone ? '已不存在' : '仍在(改名可能未生效)'}`,
            ].join('\n');
          } catch (error) {
            return failure(error);
          }
        },
      },
      {
        name: 'ov_forget',
        description:
          '永久删除 OpenViking 记忆库里的一条记忆。语义与服务自己的 `DELETE /api/v1/fs` 一致:'
          + '正文与向量记录一起移除,没有回收站、没有软删除,删了读不回来。'
          + `范围仍限 ${MEMORY_ROOT}:根目录、子树外的路径一律拒绝。`,
        parameters: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: '要删的条目 URI(文件)。' },
            recursive: { type: 'boolean', description: '删目录时是否递归,默认 false。' },
            confirm_recursive: {
              type: 'boolean',
              description: '递归删目录必须显式给 true,否则拒绝 —— 防止一句手滑删掉一整棵子树。',
            },
            reason: { type: 'string', description: '删除理由,会一并回执(留痕用)。' },
            wait: { type: 'boolean', description: '是否等语义索引刷新完,默认 true。' },
          },
          required: ['uri'],
          additionalProperties: false,
        },
        tags: ['write'],
        handler: async (args) => {
          try {
            const uri = assertWritable(args.uri);
            if (uri === MEMORY_ROOT) {
              return { text: `已拒绝:${MEMORY_ROOT} 是围栏根,不能整棵删。要删哪一条就指哪一条。`, failed: true };
            }
            const recursive = Boolean(args.recursive);
            if (recursive && args.confirm_recursive !== true) {
              return {
                text: `已拒绝:递归删除目录需要显式 confirm_recursive: true(目标 ${uri})。`,
                failed: true,
              };
            }
            if (!(await this.exists(uri))) {
              return { text: `没有删除:${uri} 不存在(可能已经删过或路径写错)。`, failed: true };
            }
            const result = await this.client.remove({ uri, recursive, wait: args.wait !== false });
            const gone = !(await this.exists(uri));
            const payload = result && typeof result === 'object' ? result : {};
            const receipt = [
              payload.estimated_deleted_count !== undefined ? `estimated_deleted_count=${payload.estimated_deleted_count}` : '',
              payload.semantic_status ? `semantic_status=${payload.semantic_status}` : '',
              payload.queue_status ? `queue_status=${payload.queue_status}` : '',
              payload.task_id ? `task_id=${payload.task_id}` : '',
            ].filter(Boolean).join(', ');
            const reason = args.reason ? `\n理由:${args.reason}` : '';
            return [
              `已永久删除 ${uri}${reason}`,
              '语义:与服务自己的 rm 一致 —— 正文与向量记录一起移除,没有回收站,删了读不回来。',
              `服务回报:${receipt || JSON.stringify(payload)}`,
              `删除后复查:${gone ? '读不到了(已确认移除)' : '仍能读到(删除可能未生效,请复核)'}`,
            ].join('\n');
          } catch (error) {
            return failure(error);
          }
        },
      },
    ];
  }

  webUi() {
    return {
      label: 'OpenViking 记忆库',
      promptDocs: [
        {
          key: 'worlds.openviking.envPrompt',
          title: 'OpenViking · 环境提示词',
          description: 'OpenViking 记忆库进 system 前缀的那一段:能查什么、能写什么、删是什么语义。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'openviking.baseUrl', description: 'OpenViking 服务地址,此刻的值。' },
            { name: 'openviking.root', description: '唯一允许读写的 URI 根,此刻的值。' },
            { name: 'openviking.delete', description: '删除语义(与服务自己的 rm 一致:永久删除)。' },
          ],
        },
      ],
    };
  }

  async start(host) {
    this.host = host;
  }

  async stop() {
    this.host = null;
  }
}

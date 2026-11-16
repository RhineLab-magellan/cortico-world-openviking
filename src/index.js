/**
 * 包入口:默认导出 `WorldDefinition`。加载器按 `cortico.kind === 'world'` 认它。
 *
 * 这里不 import 任何 `cortico/*` 模块:本包只用普通 ESM,任何 Node 都能直接动态 import 做静态检查,
 * 也不依赖宿主的类型入口跑起来。
 */
import { OpenVikingWorld } from './world.js';

/** 自描述里每个工具一句给人看的话。 */
const SUMMARIES = {
  ov_search: '语义检索 OpenViking 记忆库,返回命中的 URI、分数、来源标注和摘要。',
  ov_find: '按关键词检索 OpenViking 记忆库,带回来源标注。',
  ov_read: '按 URI 读一条记忆的正文。',
  ov_list: '列出一层记忆目录。',
  ov_tree: '看记忆库的目录树,默认限条数与字数,超限给继续分层的入口。',
  ov_grep: '正则搜记忆正文。',
  ov_glob: '按文件名通配找记忆条目,默认限条数。',
  ov_health: '查 OpenViking 服务状态、版本与鉴权模式。',
  ov_remember: '把一段内容写成一条新的记忆,可按分类目录落盘。',
  ov_write: '按 URI 写入或覆盖一条记忆。',
  ov_edit: '改已有记忆里的一段文字。',
  ov_rename: '把占位符文件名改成可读名:先备份,再用服务自己的 mv 改名。',
  ov_forget: '永久删除一条记忆,语义与服务自己的 rm 一致:正文与向量记录一起移除。',
};

/**
 * 取一遍工具声明,供自描述复用。实例的 `tools()` 才是发给模型的那份;
 * 这里只读 name/description/parameters/tags,不发起任何请求。
 */
const DECLS = (() => {
  const probe = new OpenVikingWorld({
    id: 'openviking',
    cfg: { baseUrl: 'http://127.0.0.1:1933', timeoutMs: 1_000 },
  });
  return probe.tools();
})();

/** @type {{ id: string, label: string, defaults: () => object, create: (ctx: any) => OpenVikingWorld, describe: object }} */
const OPENVIKING = {
  id: 'openviking',
  label: 'OpenViking 记忆库',

  // 每次返回全新对象,避免跨实例共享引用。
  defaults: () => ({
    enabled: false,
    baseUrl: 'http://127.0.0.1:1933',
    timeoutMs: 30_000,
  }),

  create: (ctx) =>
    new OpenVikingWorld({
      id: 'openviking',
      cfg: ctx.cfg,
      apiKey: readSecret(ctx, 'OPENVIKING_API_KEY'),
    }),

  // 自描述:给人和扩展市场看,不进提示词。
  describe: {
    tools: DECLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      tags: tool.tags,
      summary: { zh: SUMMARIES[tool.name], en: SUMMARIES[tool.name] },
    })),
    events: [],
  },
};

/** 宿主没给 secret() 时按未配置处理,不让构造失败。 */
function readSecret(ctx, name) {
  try {
    return typeof ctx.secret === 'function' ? ctx.secret(name) || undefined : undefined;
  } catch {
    return undefined;
  }
}

export default OPENVIKING;
export { OPENVIKING };

/**
 * 生成 describe.json。
 *
 * 形状必须与 Coopanion 官方的 `src/extensions/describe-export.ts` 逐字段一致,否则
 * `pnpm check:extension` 会判定「包里那份和代码对不上」:
 *
 *   { tools: [...默认导出的 describe.tools],
 *     events: [...默认导出的 describe.events],
 *     prompts: [{ key, title, role?, content }] }   // content 是模板原文
 *
 * prompts 来自 `webUi('zh').promptDocs` 里 role === 'envPrompt' 的项,按 key 去重,
 * 文件不存在的跳过;一条都没有时整个 prompts 字段不出现。
 *
 * 用法(在包根目录):node scripts/build-describe.mjs
 *
 * 正式发布前仍建议在 Cortico 仓库里跑一次官方命令核对:
 *   pnpm describe:extension <本包目录>
 *   pnpm check:extension   <本包目录>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mod = await import(new URL('../src/index.js', import.meta.url));
const def = mod.default;

const world = def.create({ cfg: def.defaults(), secret: () => undefined });
const docs = (world.webUi?.('zh')?.promptDocs ?? []).filter((doc) => doc.role === 'envPrompt');

const seen = new Set();
const prompts = [];
for (const doc of docs) {
  if (seen.has(doc.key) || !existsSync(doc.path)) continue;
  seen.add(doc.key);
  prompts.push({ key: doc.key, title: doc.title, ...(doc.role ? { role: doc.role } : {}), content: readFileSync(doc.path, 'utf8') });
}

const file = { tools: [...def.describe.tools], events: [...def.describe.events] };
if (prompts.length) file.prompts = prompts;

const canonical = JSON.parse(JSON.stringify(file));
writeFileSync(`${root}/describe.json`, `${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
console.log(`describe.json: ${canonical.tools.length} tools, ${canonical.events.length} events, ${(canonical.prompts ?? []).length} prompts`);

/**
 * 生成 describe.json —— 扩展市场与官方索引仓只读这份文件,不执行包代码。
 *
 * 用法(在包根目录):node scripts/build-describe.mjs
 *
 * 正式发布前仍建议在 Cortico 仓库里跑一次官方命令核对格式:
 *   pnpm describe:extension <本包目录>
 *   pnpm check:extension   <本包目录>
 * 那份脚本会用同样的信息覆盖这个文件,并校验它和代码一致。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mod = await import(new URL('../src/index.js', import.meta.url));
const def = mod.default;

const probe = def.create({ cfg: def.defaults(), secret: () => undefined });
const ui = typeof probe.webUi === 'function' ? probe.webUi('zh') : {};
const promptDocs = (ui.promptDocs ?? [])
  .filter((doc) => doc.role === 'envPrompt')
  .map((doc) => ({
    key: doc.key,
    title: doc.title,
    description: doc.description,
    vars: doc.vars ?? [],
    body: readFileSync(doc.path, 'utf8'),
  }));

const out = { tools: def.describe.tools, events: def.describe.events ?? [], promptDocs };
writeFileSync(`${root}/describe.json`, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`describe.json: ${out.tools.length} tools, ${promptDocs.length} prompts`);

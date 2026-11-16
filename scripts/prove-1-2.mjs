/**
 * 验收 1 + 2:动态 import 包入口,证默认导出是 WorldDefinition,并打印实例 tools() 的 name + tags。
 * 用法:node prove-1-2.mjs [包目录]   —— 不给目录就用当前目录
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkgDir = process.argv[2] || '.';

const entry = pathToFileURL(path.join(path.resolve(pkgDir), 'src', 'index.js'));
const mod = await import(entry.href);

const def = mod.default;
console.log('== 1. 动态 import ==');
console.log('entry_url        :', entry.href);
console.log('default_export_type:', typeof def);
console.log('is_object        :', typeof def === 'object' && def !== null);
if (!def || typeof def !== 'object') {
  console.error('FAIL: default export is not an object');
  process.exit(1);
}
console.log('def.id           :', JSON.stringify(def.id));
console.log('def.label        :', JSON.stringify(def.label));
console.log('has_defaults     :', typeof def.defaults === 'function');
console.log('has_create       :', typeof def.create === 'function');
console.log('defaults()       :', JSON.stringify(def.defaults()));

const cfg = { ...def.defaults(), enabled: true };
const world = def.create({ id: def.id, cfg, secret: () => '', botName: 'test' });

console.log('\n== 2. world.tools() ==');
console.log('world.id         :', world.id);
const tools = world.tools();
for (const tool of tools) {
  const req = tool.parameters?.required ?? [];
  console.log(`  ${tool.name.padEnd(12)} tags=[${tool.tags.join(',')}]  required=[${req.join(',')}]`);
}
console.log('tool_count       :', tools.length);

const names = new Set();
for (const tool of tools) {
  if (typeof tool.name !== 'string' || !tool.name) throw new Error('tool without a name');
  if (names.has(tool.name)) throw new Error(`duplicate tool name ${tool.name}`);
  names.add(tool.name);
  if (!Array.isArray(tool.tags) || tool.tags.length === 0) throw new Error(`${tool.name}: empty tags`);
  for (const tag of tool.tags) {
    if (!['read', 'write', 'speak', 'act', 'flow', 'snapshot'].includes(tag)) {
      throw new Error(`${tool.name}: unknown tag ${tag}`);
    }
  }
  if (typeof tool.handler !== 'function') throw new Error(`${tool.name}: no handler`);
}
console.log('all_tool_names_unique:', names.size === tools.length);

console.log('\n== envPromptVars() ==');
console.log(JSON.stringify(world.envPromptVars(), null, 2));

const webUi = world.webUi();
console.log('\n== webUi().promptDocs ==');
for (const doc of webUi.promptDocs ?? []) {
  console.log(`  ${doc.key} role=${doc.role} path=${doc.path}`);
}

/* ================= 验收 1–2:改动前后的量化 ================= */
console.log('\n== 3. 验收 1:ov_health 带出版本与鉴权模式 ==');
const run = async (name, args) => {
  const tool = tools.find((t) => t.name === name);
  const out = await tool.handler(args, { role: 'acceptance', log: console });
  return typeof out === 'string' ? { text: out, failed: false } : { text: out.text, failed: Boolean(out.failed) };
};
const health = await run('ov_health', {});
console.log('before: OpenViking 在线:undefined   (GET /health 是平铺对象,client 只取 payload.result)');
console.log('after :', health.text);
const healthOk = health.failed === false
  && !/undefined/.test(health.text)
  && /版本\s+\S+/.test(health.text)
  && /鉴权模式\s+\S+/.test(health.text);
if (!healthOk) {
  console.error('FAIL: ov_health 仍缺版本或鉴权模式,或仍带 undefined');
  process.exit(1);
}

console.log('\n== 4. 验收 2:列表默认封顶(字符 + 入口)==');
const countTreeRows = (text) => {
  const lines = text.split('\n');
  const dirs = lines.filter((l) => l.trim().startsWith('[dir]')).length;
  const files = lines.filter((l) => !l.trim().startsWith('[dir]') && /\.md\s*$/.test(l.trim())).length;
  return { dirs, files, entries: dirs + files };
};
const tree = await run('ov_tree', { level_limit: 3 });
const treeRows = countTreeRows(tree.text);
console.log(`ov_tree level_limit=3  before: ${4016} 字 / ${1} 行(整块 JSON,raw 72835 字 / 服务端 400 条取满)
                        after : ${tree.text.length} 字 / ${tree.text.split('\n').filter((l) => l.trim()).length} 行 / 目录 ${treeRows.dirs} + 文件 ${treeRows.files} = ${treeRows.entries} 条(默认上限 60)`);
console.log(`有继续分层入口: ${tree.text.includes('继续往下看')}`);

const glob = await run('ov_glob', { pattern: 'entities/**/*.md' });
const globRows = glob.text.split('\n').filter((l) => /^\d+\.\s/.test(l)).length;
console.log(`ov_glob entities/**/*.md  before: ${4016} 字 / ${1} 行(整块 JSON,raw 13571 字 / 204 条)
                          after : ${glob.text.length} 字 / ${globRows} 条(默认上限 50)`);

const problems = [];
if (tree.failed || tree.text.length >= 4000) problems.push('ov_tree 仍超过 4000 字');
if (treeRows.entries > 60) problems.push(`ov_tree 默认列出 ${treeRows.entries} 条,超过上限 60`);
if (!tree.text.includes('继续往下看')) problems.push('ov_tree 没有继续分层入口');
if (tree.text.trimStart().startsWith('[{')) problems.push('ov_tree 仍是整块 JSON');
if (glob.failed || glob.text.length >= 4000) problems.push('ov_glob 仍超过 4000 字');
if (globRows > 50) problems.push(`ov_glob 默认列出 ${globRows} 条,超过 50`);
if (!glob.text.includes('继续往下看')) problems.push('ov_glob 没有继续办法');

if (problems.length) {
  console.error('\nFAIL:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\nRESULT: PASS');

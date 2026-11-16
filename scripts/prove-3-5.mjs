/**
 * 验收 1–7:对活着的 OpenViking 跑真实调用。
 * 用法:node prove-3-5.mjs [包目录]   —— 不给目录就用当前目录
 *
 * 只通过插件自己的 tools() 调用 —— 不绕过 handler 直接打 HTTP,
 * 这样「读成功」「写落在哪」「删了没有」「拒没拒」都是插件真实路径的结果。
 *
 * 期望:全部断言通过,exit 0;任何一条不通过,打印 FAIL 行并以 exit 1 退出。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkgDir = process.argv[2] || '.';

const { default: def } = await import(pathToFileURL(path.join(path.resolve(pkgDir), 'src', 'index.js')).href);

const cfg = { ...def.defaults(), enabled: true };
const world = def.create({ id: def.id, cfg, secret: () => '' });
const tools = new Map(world.tools().map((t) => [t.name, t]));
const ROOT = 'viking://user/default/memories';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

function head(text, n = 700) {
  const flat = String(text ?? '');
  return flat.length <= n ? flat : `${flat.slice(0, n)}\n…(本行截断,完整 ${flat.length} 字)`;
}

function nonEmptyLines(text) {
  return String(text ?? '').split('\n').filter((l) => l.trim());
}

async function run(name, args) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  const out = await tool.handler(args, { role: 'acceptance', log: console });
  return typeof out === 'string' ? { text: out, failed: false } : { text: out.text, failed: Boolean(out.failed) };
}

/* ============ 1. ov_health:版本与鉴权模式,且不再有 undefined ============ */
console.log('=========== 1. ov_health 带出版本与鉴权模式 ===========');
const health = await run('ov_health', {});
console.log(`[ov_health] failed=${health.failed}`);
console.log(health.text);
check('failed=false', health.failed === false);
check('文本里没有 undefined', !/undefined/.test(health.text), health.text);
check('带出服务地址', health.text.includes(cfg.baseUrl));
const versionMatch = health.text.match(/版本\s+(\S+)/);
const authMatch = health.text.match(/鉴权模式\s+(\S+)/);
check('版本字段有实际值', Boolean(versionMatch) && versionMatch[1] !== '服务未返回版本', versionMatch?.[1]);
check('鉴权模式字段有实际值', Boolean(authMatch) && authMatch[1] !== '服务未返回鉴权模式', authMatch?.[1]);

/* ============ 2. ov_tree / ov_glob 默认封顶 + 继续入口 ============ */
console.log('\n=========== 2a. ov_tree 默认参数有硬上限 ===========');
const tree = await run('ov_tree', { level_limit: 3 });
console.log(`[ov_tree level_limit=3] failed=${tree.failed}`);
const treeLines = nonEmptyLines(tree.text);
console.log(`chars=${tree.text.length} lines=${treeLines.length}`);
console.log(head(tree.text, 900));
check('failed=false', tree.failed === false);
check('总字符 < 4000(改动前是 4016 字整块 JSON)', tree.text.length < 4000, `${tree.text.length} 字`);
check('不再是一整行 JSON', !treeLines[0]?.startsWith('[{'), treeLines[0]?.slice(0, 40));
check('给了继续分层的入口', tree.text.includes('继续往下看') && tree.text.includes('ov_tree uri='));
check('写明了截断', tree.text.includes('已截断'));
const treeRows = treeLines.filter((l) => /^\s*(\[dir\] )?[^\s]/.test(l) && !l.startsWith('  -') && !l.startsWith('…'));
console.log(`tree_rows_after_header=${treeRows.length}`);

console.log('\n=========== 2b. ov_glob 默认有上限 ===========');
const glob = await run('ov_glob', { pattern: 'entities/**/*.md' });
console.log(`[ov_glob entities/**/*.md] failed=${glob.failed}`);
const globLines = nonEmptyLines(glob.text);
console.log(`chars=${glob.text.length} lines=${globLines.length}`);
console.log(head(glob.text, 700));
check('failed=false', glob.failed === false);
check('不再是一整行 JSON', !globLines[0]?.startsWith('{"matches"'), globLines[0]?.slice(0, 40));
check('默认条数上限 50', /本次最多列 50 条/.test(glob.text));
check('写明了截断与继续办法', glob.text.includes('已截断') && glob.text.includes('继续往下看'));
check('总字符 < 4000(改动前是 4016 字)', glob.text.length < 4000, `${glob.text.length} 字`);
const globRows = globLines.filter((l) => /^\d+\.\s/.test(l));
check('实际列出条数 <= 50', globRows.length <= 50, `${globRows.length} 条`);

const glob200 = await run('ov_glob', { pattern: 'entities/**/*.md', limit: 500 });
const glob200Rows = nonEmptyLines(glob200.text).filter((l) => /^\d+\.\s/.test(l));
console.log(`[ov_glob limit=500 被夹到上限] rows=${glob200Rows.length}`);
check('limit 被硬夹在 200', glob200Rows.length <= 200, `${glob200Rows.length} 条`);

/* ============ 3. 写入路径不把占位符放进文件名 ============ */
console.log('\n=========== 3. 含 {{...}} 的写入 → 文件名是可读 slug ===========');
const PLACEHOLDER = '{{ov_privacy_default_viking___~_privacy_session_acceptance}}';
const probeContent = [
  `# 占位符文件名验收 ${PLACEHOLDER}`,
  '',
  '这一条由验收脚本写入,首行就带着占位符,用来证明文件名会摘掉它、正文会保留它。',
  `正文里的占位符:${PLACEHOLDER}`,
  `写入时刻:${new Date().toISOString()}`,
].join('\n');
const wrote = await run('ov_remember', { content: probeContent });
console.log(`[ov_remember 含占位符] failed=${wrote.failed}`);
console.log(wrote.text);
check('failed=false', wrote.failed === false);
const probeUri = (wrote.text.match(/已写入 (\S+?)\(/) ?? [])[1] ?? '';
const probeLeaf = probeUri.slice(probeUri.lastIndexOf('/') + 1);
console.log('probe_uri  =', probeUri);
console.log('probe_leaf =', probeLeaf);
check('拿到落盘 URI', Boolean(probeUri));
check('文件名里没有 {{ / }}', !/[{}]/.test(probeLeaf), probeLeaf);
check('文件名是可读 slug(含首行中文字)', /占位符文件名验收/.test(probeLeaf), probeLeaf);
check('落在围栏根下', probeUri.startsWith(`${ROOT}/`));

const probeBack = await run('ov_read', { uri: probeUri, limit: -1 });
check('正文里占位符仍在', probeBack.text.includes('{{ov_privacy_default_viking'), '回读校验');
console.log('回读正文片段:', head(probeBack.text, 220));

/** 改名工具的两种保护:同名→「没有改动」;目标已存在→拒绝覆盖。与是否本轮改名无关。 */
async function proveRenameGuards(uri) {
  if (!uri) return check('改名保护:拿到一个可测的 URI', false);
  const same = await run('ov_rename', { uri, new_name: uri.slice(uri.lastIndexOf('/') + 1) });
  console.log(`[ov_rename 同名] failed=${same.failed} — ${same.text.split('\n')[0]}`);
  check('同名改名被识别为「没有改动」', same.failed === false && same.text.includes('没有改动'));

  const parent = uri.slice(0, uri.lastIndexOf('/'));
  const clashSibling = `${parent}/clash-probe.md`;
  await run('ov_write', { uri: clashSibling, content: '# clash probe\n\n同名拒绝用的兄弟条目。', mode: 'create' });
  const clash = await run('ov_rename', { uri, new_name: 'clash-probe' });
  console.log(`[ov_rename 撞名] failed=${clash.failed} — ${clash.text.split('\n')[0]}`);
  check('目标已存在时拒绝覆盖', clash.failed === true && clash.text.includes('已经存在'));
  const clashGone = await run('ov_forget', { uri: clashSibling, reason: '清理同名拒绝探针' });
  check('撞名探针已清理', clashGone.failed === false, clashGone.text.split('\n')[0]);
}

/* ============ 4. 存量占位符文件名条目改名(先备份,正文保留占位符) ============ */
console.log('\n=========== 4. 存量占位符文件名条目改名 ===========');
let legacyUri = '';
const hosting = await run('ov_glob', { pattern: 'entities/code_hosting/*.md', limit: 100 });
for (const line of nonEmptyLines(hosting.text)) {
  if (line.includes('{{') && /^\d+\.\s/.test(line)) {
    legacyUri = `${ROOT}/${line.replace(/^\d+\.\s+/, '').trim()}`;
    break;
  }
}
console.log('legacy_uri =', legacyUri);
const RENAMED_URI = `${ROOT}/entities/code_hosting/privacy-credential-github-pat-58963d41e605eb09.md`;
if (!legacyUri) {
  // 上一次运行已经把它改掉了:这里复核结果态,而不是假装跳过。
  console.log('  (存量里已无带占位符的文件名条目 —— 前一次运行已改名,本次复核结果态)');
  const done = await run('ov_read', { uri: RENAMED_URI, limit: -1 });
  console.log('结果态新名读取 failed=' + done.failed);
  check('改名结果仍在(新名可读)', done.failed === false);
  check('结果态正文仍含占位符', done.text.includes('{{ov_privacy'));
  const backupList = await run('ov_glob', { pattern: 'backups/**/*.md', limit: 100 });
  console.log(head(backupList.text, 500));
  check(
    '改名前的备份还在 memories/backups/ 下',
    backupList.failed === false && backupList.text.includes('privacy-credential-github-pat-58963d41e605eb09-backup.md'),
  );
  const stillLegacy = await run('ov_glob', { pattern: '**/*[{][{]*.md', limit: 50 });
  check(
    '整个围栏内已无占位符文件名(glob **/*[{][{]*.md)',
    stillLegacy.failed === false && !/^\d+\.\s/m.test(stillLegacy.text),
    head(stillLegacy.text, 200),
  );
  await proveRenameGuards(RENAMED_URI);
} else {
  const legacyBefore = await run('ov_read', { uri: legacyUri, limit: 4 });
  check('改名前来体读得到', !legacyBefore.failed);
  check('改名前正文带占位符', legacyBefore.text.includes('{{'), '首 4 行');

  const renamed = await run('ov_rename', {
    uri: legacyUri,
    new_name: 'privacy-credential-github-pat-58963d41e605eb09',
  });
  console.log(`[ov_rename] failed=${renamed.failed}`);
  console.log(renamed.text);
  check('failed=false', renamed.failed === false);
  const newUri = (renamed.text.match(/→ (\S+)/) ?? [])[1] ?? '';
  const backupUri = (renamed.text.match(/备份:(\S+?)\(/) ?? [])[1] ?? '';
  console.log('new_uri    =', newUri);
  console.log('backup_uri =', backupUri);
  check('新文件名可读且无占位符', Boolean(newUri) && !/[{}]/.test(newUri), newUri);
  check('备份落在 memories/backups/ 下', backupUri.startsWith(`${ROOT}/backups/`), backupUri);
  check('回执称正文逐字一致', renamed.text.includes('逐字一致'));
  check('回执称占位符仍保留在正文里', renamed.text.includes('占位符仍保留在正文里'));
  check('旧路径已不存在', renamed.text.includes('旧路径:已不存在'));

  const newBack = await run('ov_read', { uri: newUri, limit: -1 });
  check('新路径读得到', !newBack.failed);
  check('新路径正文仍含占位符', newBack.text.includes('{{ov_privacy'), '正文校验');
  const legacyAfter = await run('ov_read', { uri: legacyUri, limit: 1 });
  check('旧路径读不到', legacyAfter.failed === true);
  const backupBack = await run('ov_read', { uri: backupUri, limit: -1 });
  check('备份读得到', !backupBack.failed);
  check('备份正文含占位符', backupBack.text.includes('{{ov_privacy'));

  // 撞名拒绝:在同目录造一个兄弟条目,再拿它的名字当改名目标。
  await proveRenameGuards(newUri);
}

/* ============ 5. ov_forget:与服务一致的永久删除 + 围栏 ============ */
console.log('\n=========== 5a. ov_forget 真的删掉(永久删除,服务自己的语义) ===========');
const forgot = await run('ov_forget', { uri: probeUri, reason: 'acceptance probe — 该条是本轮写入的探针' });
console.log(`[ov_forget probe] failed=${forgot.failed}`);
console.log(forgot.text);
check('failed=false', forgot.failed === false);
check('回执写明永久删除与服务语义', /永久删除/.test(forgot.text) && /没有回收站/.test(forgot.text));
check('带出服务自己的回报字段', /semantic_status=|estimated_deleted_count=|queue_status=/.test(forgot.text));
check('复查为已移除', forgot.text.includes('读不到了(已确认移除)'));

const afterForget = await run('ov_read', { uri: probeUri, limit: 1 });
console.log(`[删除后再读 probe] failed=${afterForget.failed}`);
console.log(afterForget.text);
check('删除后读不到探针条目', afterForget.failed === true);

console.log('\n=========== 5b. 删除范围仍限围栏 ===========');
const rootForget = await run('ov_forget', { uri: ROOT });
check('删根目录被拒', rootForget.failed === true, rootForget.text);
const outsideForget = await run('ov_forget', { uri: 'viking://resources/anything.md' });
check('删 viking://resources 被拒', outsideForget.failed === true, outsideForget.text);
const missingForget = await run('ov_forget', { uri: `${ROOT}/cases/definitely-not-here.md` });
check('删不存在的条目被拒', missingForget.failed === true, missingForget.text);
const recursiveForget = await run('ov_forget', { uri: `${ROOT}/cases`, recursive: true });
check('递归删目录未确认被拒', recursiveForget.failed === true, recursiveForget.text);

/* ============ 6. ov_remember 按分类目录落盘 ============ */
console.log('\n=========== 6. ov_remember 按目录落盘 ===========');
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
const dirTarget = `events/${day}/acceptance`;
const withDir = await run('ov_remember', {
  content: `# 分类目录验收\n\n写入到 ${dirTarget}。\n标记:COOPANION_R0010_DIR_PROBE`,
  name: 'r0010-dir-probe',
  dir: `${dirTarget}/`,
});
console.log(`[ov_remember dir=${dirTarget}/] failed=${withDir.failed}`);
console.log(withDir.text);
check('failed=false', withDir.failed === false);
check('落在指定目录下', withDir.text.includes(`/${dirTarget}/r0010-dir-probe.md`), withDir.text);
const dirUri = `${ROOT}/${dirTarget}/r0010-dir-probe.md`;
const dirBack = await run('ov_read', { uri: dirUri, limit: -1 });
check('目录条目回读成功', !dirBack.failed && dirBack.text.includes('COOPANION_R0010_DIR_PROBE'));

const withoutDir = await run('ov_remember', {
  content: `# 根目录行为不变验收\n\n标记:COOPANION_R0010_ROOT_PROBE`,
  name: 'r0010-root-probe',
});
console.log(`\n[ov_remember 不给 dir] failed=${withoutDir.failed}`);
console.log(withoutDir.text);
check('不给 dir 仍落在根上(行为不变)', withoutDir.text.includes(`已写入 ${ROOT}/r0010-root-probe.md`));

// 清掉本轮两条探针(也顺带再证一次删除可用)
const cleanDir = await run('ov_forget', { uri: dirUri, reason: '清理本轮目录探针' });
const cleanRoot = await run('ov_forget', { uri: `${ROOT}/r0010-root-probe.md`, reason: '清理本轮根探针' });
check('目录探针已清理', cleanDir.failed === false, cleanDir.text.split('\n')[0]);
check('根探针已清理', cleanRoot.failed === false, cleanRoot.text.split('\n')[0]);

/* ============ 7. 检索结果带来源标注,不把他人身份当自己 ============ */
console.log('\n=========== 7. 检索结果带来源标注 ===========');
const search = await run('ov_search', { query: '席位身份 工具面 互斥禁令', limit: 5 });
console.log(`[ov_search] failed=${search.failed}`);
console.log(head(search.text, 900));
check('failed=false', search.failed === false);
const hitLines = nonEmptyLines(search.text).filter((l) => /^\d+\.\s+viking:\/\//.test(l));
check('每条命中都带来源标注', hitLines.length > 0 && hitLines.every((l) => l.includes('【来源:') || l.includes('【席位身份')), `${hitLines.length} 条命中`);
check('来源标注写清了分类目录', hitLines.some((l) => /【来源:memories\/[^】]+】/.test(l)));

const find = await run('ov_find', { query: 'identity', limit: 4 });
const findHits = nonEmptyLines(find.text).filter((l) => /^\d+\.\s+viking:\/\//.test(l));
console.log(`\n[ov_find identity] hits=${findHits.length}`);
console.log(head(find.text, 600));
check('ov_find 也带来源标注', findHits.length > 0 && findHits.every((l) => l.includes('【来源:') || l.includes('【席位身份')));

const identityRead = await run('ov_read', { uri: `${ROOT}/identity.md`, limit: 3 });
console.log('\n[ov_read identity.md] failed=' + identityRead.failed);
console.log(head(identityRead.text, 400));
check('读 identity.md 时标出席位归属', /【席位身份:[^】]*—— 属于那个席位,不是当前身份的记忆】/.test(identityRead.text));
check('标注点出了具体席位名', /【席位身份:qa/.test(identityRead.text), (identityRead.text.match(/【席位身份:[^】]+】/) ?? [])[0]);

/* ============ 汇总 ============ */
console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures} 项不通过)`}`);
process.exit(failures === 0 ? 0 : 1);

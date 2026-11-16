# cortico-world-openviking

Coopanion 的一个 World 扩展:把本机 **OpenViking 的记忆库**直接接进来,能查、能写回、能按服务自己的语义删除。

它只做一件事 —— 直接读写 `viking://user/default/memories` 这一棵子树,也就是**原版记忆库本身**。
它不读、不写 Coopanion 自己那本 Memory,也不碰 `viking://resources`。

## 版本要求

| OpenViking 版本 | 状态 |
| --- | --- |
| 0.5.3 / 0.5.4 / 0.5.4.1 / 0.5.5 | 验证通过 |
| 低于 0.5.3 | **不支持**。`ov_health` 会直接回一行升级提示,检索与写入可能报错 |
| 0.6 及以后 | 未验证 |

本扩展只用到这几个接口,只要它们不变就能用:`GET /health`、`POST /api/v1/search/{search,find,grep,glob}`、
`GET /api/v1/content/read`、`POST /api/v1/content/write`、`GET /api/v1/fs/{ls,tree}`、
`POST /api/v1/fs/{mkdir,mv}`、`DELETE /api/v1/fs`。

装之前先确认服务在跑:`curl http://127.0.0.1:1933/health` 应该回 `"status":"ok"` 并带上版本号。

## 能力

| 工具 | tag | 作用 |
| --- | --- | --- |
| `ov_search` | read | 语义检索,返回 URI / 分数 / **来源标注** / 摘要 |
| `ov_find` | read | 关键词检索,同样带来源标注 |
| `ov_read` | read | 按 URI 读正文;读席位身份文件时顶部标出「这是哪个席位的」 |
| `ov_list` | read | 列一层目录 |
| `ov_tree` | read | 看目录树,**默认 60 条 / 2400 字封顶**,超限给继续分层的入口 |
| `ov_grep` | read | 正则搜正文 |
| `ov_glob` | read | 按文件名通配,**默认 50 条封顶**(上限 200) |
| `ov_health` | read | 服务状态 + **版本 + 鉴权模式**;版本低于 0.5.3 时给出升级提示 |
| `ov_remember` | write | 写成一条新记忆,可用 `dir` 指定分类目录 |
| `ov_write` | write | 按 URI 写入或覆盖 |
| `ov_edit` | write | 改已有条目里的一段文字(要求唯一匹配) |
| `ov_rename` | write | 把占位符文件名改成可读名:先备份,再用服务自己的 `mv` 改名 |
| `ov_forget` | write | **永久删除**,语义与服务自己的 `rm` 一致 |

## 删除语义(与服务自己的标准一致)

这个扩展没有自己的回收站,也不做软删除。它的删除就是 OpenViking 服务自己的删除:

- 接口:`DELETE /api/v1/fs?uri=<uri>&recursive=<bool>&wait=<bool>`(`operationId: rm_api_v1_fs_delete`)。
- 服务端实现链路:`server/routers/filesystem.py` 的 `rm` → `service/fs_service.py` 的 `rm`(ACL 要
  `MANAGE`)→ `storage/viking_fs/_ops.py` 的 `rm`:先删 VectorDB 里的记录,再调 AGFS 的 `rm` 物理删掉内容。
  **没有回收站、没有隔离区,删除前也不会自动存快照**;唯一能反悔的机会是操作者事先自己调
  `/api/v1/snapshot/commit` 存一个快照。
- 范围仍是 `viking://user/default/memories`:根目录本身、子树外的路径、`viking://resources` 一律拒绝;
  递归删目录还要显式给 `confirm_recursive: true`。
- 回执会把服务自己返回的 `estimated_deleted_count` / `semantic_status` / `queue_status` 原样带出来,
  并复查一次「删完还读不读得到」。

## 围栏(代码里硬拦,不是提示)

- 唯一允许的根:`viking://user/default/memories`。读和写同一棵。
- `viking://resources`、`viking://~/skills`、`viking://user/<别人>/…` 一律拒绝 —— 在发出 HTTP 请求之前就拒。
- `viking://~/x` 这种别名先展开再比较,`..` 段和百分号编码的路径分隔符直接拒绝。
- **写入路径里不许出现 `{{...}}` 占位符**:`assertWritable` 直接拒;`ov_remember` 的自动文件名与显式
  `name` 都会先摘掉占位符再落盘。占位符只属于正文。
- 整个包只往配置的 `baseUrl` 发 HTTP;没有 `node:fs`,没有 `child_process`,也不引用任何 Coopanion 内部路径。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否挂载 |
| `baseUrl` | `http://127.0.0.1:1933` | OpenViking 地址 |
| `timeoutMs` | `30000` | 单次请求超时 |

OpenViking 处于 `auth_mode=dev` 时不需要密钥;需要时通过宿主 secret `OPENVIKING_API_KEY` 提供(以 `Authorization: Bearer` 发出),不会写进配置。

## 安装

**从扩展市场装**:Coopanion 的「扩展」页搜索「OpenViking 记忆库」(包名 `cortico-world-openviking`),
装完重启进程,到 Worlds 页启用。

**开发时从本机目录装**:本包是普通 ESM,`main` 指向 `src/index.js`,不 import 任何 `cortico/*` 模块,
因此可以用纯 `node` 做静态装载检查。

1. 把整个目录复制到 `D:\Coco\Coopanion\data\extensions\cortico-world-openviking`。
2. 让宿主能解析到它 —— 在 `D:\Coco\Coopanion\data\extensions\package.json` 的 `dependencies` 里加一行,
   然后在同一目录跑一次 `pnpm install`:

   ```json
   "cortico-world-openviking": "link:./cortico-world-openviking"
   ```

3. 激活。两种等价方式:
   - **控制台的 Worlds / 扩展页**:复制完并装好依赖后,它会作为「本地已有实现但当前未激活」出现,点激活即可 —— 这一步会热写回配置,不用重启进程。
   - **手改配置**:`D:\Coco\Coopanion\data\home\companion\config.json` 的 `worlds` 里加
     ```json
     "openviking": { "enabled": true, "baseUrl": "http://127.0.0.1:1933" }
     ```
     这一步同样热生效(`worlds.<id>.enabled`)。

## 自检

```powershell
node scripts\prove-1-2.mjs .                     # 装载、默认导出、工具名与 tag,外加验收 1–2 的前后对比
node scripts\prove-3-5.mjs .                     # 对活着的 OpenViking 跑真实写入/改名/删除/拒绝(验收 1–7)
node scripts\prove-no-deletion.mjs .             # 清单对账:除脚本自己写又删的两条探针,一条都没少
```

三条都从包目录下跑(参数可省,默认当前目录),退出码 0 表示全过。

## 已知副作用

- `ov_remember` 验收时写入的探针条目会被同一轮 `ov_forget` 删掉(这本身就是验收项)。
- `ov_rename` 会在 `viking://user/default/memories/backups/rename-<时间戳>/` 留一份正文备份;
  备份是改名前的副本,可以事后自己清理。

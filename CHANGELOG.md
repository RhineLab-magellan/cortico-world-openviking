# Changelog

## 0.1.0 - 2026-11-16

首个公开版本。

- **需要 OpenViking 0.5.3 或更高**(已验证 0.5.3 / 0.5.4 / 0.5.4.1 / 0.5.5)。低于 0.5.3 时
  `ov_health` 会直接回一行升级提示,而不是让后面的调用零散报错。
- 13 个工具:7 个读(`ov_search`、`ov_find`、`ov_read`、`ov_list`、`ov_tree`、`ov_grep`、`ov_glob`)、
  1 个状态(`ov_health`)、5 个写(`ov_remember`、`ov_write`、`ov_edit`、`ov_rename`、`ov_forget`)。
- 所有读写围在 `viking://user/default/memories` 这一棵子树里,子树外的路径在发出 HTTP 之前就拒。
- 删除语义与 OpenViking 自己的 `rm` 完全一致:正文与向量记录一起移除,没有回收站,删之前不存快照。
- 列表类工具有默认上限,截断时给出「继续往下看」的具体命令,不静默吞结果。

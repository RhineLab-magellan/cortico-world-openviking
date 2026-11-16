/**
 * OpenViking HTTP 客户端。
 *
 * 只走 http(s) 到配置的 baseUrl,不读文件系统、不引用 Coopanion 的 Memory。
 *
 * 响应有两种形态,这里一并抹平:大多数接口是 { status, result } 信封;
 * `/health` 是平铺对象 { status, healthy, version, auth_mode }。以前只取 `payload.result`,
 * 于是 health 拿到 undefined —— 现在「有 result 就取 result,没有就把整个 payload 当结果」。
 */

export class OpenVikingError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'OpenVikingError';
    this.detail = detail;
  }
}

export function createClient({ baseUrl, apiKey, timeoutMs = 30_000 }) {
  const root = String(baseUrl ?? '').replace(/\/+$/, '');

  async function call(method, path, { query, body } = {}) {
    const url = new URL(root + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new OpenVikingError(`连不上 OpenViking(${root}):${cause?.message ?? cause}`);
    }

    const text = await res.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new OpenVikingError(`OpenViking 返回了非 JSON 响应(HTTP ${res.status})`, text.slice(0, 400));
    }
    if (!res.ok || payload.status === 'error') {
      const message = payload?.error?.message ?? payload?.detail ?? text.slice(0, 400);
      throw new OpenVikingError(`OpenViking ${method} ${path} 失败(HTTP ${res.status}):${message}`, payload?.error);
    }
    if (payload && typeof payload === 'object' && 'result' in payload) return payload.result;
    return payload;
  }

  return {
    health: () => call('GET', '/health'),
    search: ({ query, uri, limit }) =>
      call('POST', '/api/v1/search/search', { body: { query, target_uri: uri, limit, mode: 'list' } }),
    find: ({ query, uri, limit }) =>
      call('POST', '/api/v1/search/find', { body: { query, target_uri: uri, limit } }),
    read: ({ uri, offset, limit }) => call('GET', '/api/v1/content/read', { query: { uri, offset, limit } }),
    // 服务端 ls 默认只回 1000 个节点并置 has_more;这里显式要一个够大的上限,
    // 否则「整棵树」其实是前 1000 个节点,对账会误判成条目消失。
    list: ({ uri, recursive, nodeLimit = 5000 }) =>
      call('GET', '/api/v1/fs/ls', {
        query: { uri, recursive: recursive ? true : undefined, output: 'original', node_limit: nodeLimit },
      }),
    tree: ({ uri, levelLimit, nodeLimit }) =>
      call('GET', '/api/v1/fs/tree', {
        query: { uri, level_limit: levelLimit, node_limit: nodeLimit },
      }),
    grep: ({ uri, pattern, caseInsensitive }) =>
      call('POST', '/api/v1/search/grep', { body: { uri, pattern, case_insensitive: Boolean(caseInsensitive) } }),
    glob: ({ pattern, uri, limit }) =>
      call('POST', '/api/v1/search/glob', { body: { pattern, uri, node_limit: limit } }),
    write: ({ uri, content, mode }) => call('POST', '/api/v1/content/write', { body: { uri, content, mode } }),
    // 建目录:分类落盘(events/2026/11/13)之前先把目录立出来。
    mkdir: ({ uri }) => call('POST', '/api/v1/fs/mkdir', { body: { uri } }),
    // 服务自己的改名原语(openapi: POST /api/v1/fs/mv, MvRequest { from_uri, to_uri })。
    move: ({ fromUri, toUri }) =>
      call('POST', '/api/v1/fs/mv', { body: { from_uri: fromUri, to_uri: toUri } }),
    // 服务自己的删除原语(openapi: DELETE /api/v1/fs?uri=&recursive=&wait=)。
    remove: ({ uri, recursive, wait }) =>
      call('DELETE', '/api/v1/fs', {
        query: { uri, recursive: recursive ? true : undefined, wait: wait ? true : undefined },
      }),
  };
}

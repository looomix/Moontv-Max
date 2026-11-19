/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { AdminConfig } from '@/lib/admin.types';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { getStorage } from '@/lib/db';
import { IStorage } from '@/lib/types';

export const runtime = 'edge';

// 支持的操作类型
type Action =
  | 'add'
  | 'disable'
  | 'enable'
  | 'delete'
  | 'sort'
  | 'batchDisable'
  | 'batchEnable'
  | 'batchDelete'
  | 'import'
  | 'check';

interface BaseBody {
  action?: Action;
}

interface ParsedSource {
  key: string;
  name: string;
  api: string;
  detail?: string;
}

/** 规范化 URL：去空白、补协议、去尾斜杠 */
function normalizeApi(raw: string): string {
  let api = (raw || '').trim();
  if (!api) return '';
  if (!/^https?:\/\//i.test(api)) {
    api = `https://${api}`;
  }
  return api.replace(/\/+$/, '');
}

/** 从 API 地址生成一个稳定的 key（主机名 + 路径去噪） */
function keyFromApi(api: string): string {
  try {
    const u = new URL(api);
    const host = u.hostname.replace(/^www\./, '');
    return host || api;
  } catch {
    return api.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60) || 'source';
  }
}

/**
 * 通用源解析器，兼容多种常见订阅格式：
 * 1. LunaTV/TVBox 风格对象：{ api_site: { key: { name, api, detail } } }
 * 2. TVBox 站点对象：{ sites: [{ key, name, api }] }
 * 3. 数组：{ id, name, baseUrl } / { id, name, url } / { key, name, api }
 * 4. 纯文本：每行 `名称|API|类型|可用率` 或仅一个 API 地址
 */
function parseSourcePayload(text: string): ParsedSource[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // ---- JSON 结构 ----
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data: any;
    try {
      data = JSON.parse(trimmed);
    } catch {
      data = null;
    }

    if (data) {
      const result: ParsedSource[] = [];

      // 组：api_site
      const apiSite = data.api_site || data.apiSite;
      if (apiSite && typeof apiSite === 'object' && !Array.isArray(apiSite)) {
        Object.entries(apiSite).forEach(([k, v]: [string, any]) => {
          const api = normalizeApi(v?.api || v?.baseUrl || v?.url || '');
          if (!api) return;
          result.push({
            key: String(v?.key || k || keyFromApi(api)),
            name: String(v?.name || k || keyFromApi(api)),
            api,
            detail: v?.detail ? String(v.detail) : undefined,
          });
        });
        return result;
      }

      // 组：sites
      const list = Array.isArray(data)
        ? data
        : Array.isArray(data.sites)
          ? data.sites
          : Array.isArray(data.list)
            ? data.list
            : [];

      list.forEach((item: any) => {
        if (!item || typeof item !== 'object') return;
        const api = normalizeApi(
          item.api || item.baseUrl || item.url || item.ext?.api || ''
        );
        if (!api) return;
        result.push({
          key: String(item.key || item.id || keyFromApi(api)),
          name: String(item.name || item.title || keyFromApi(api)),
          api,
          detail: item.detail ? String(item.detail) : undefined,
        });
      });
      return result;
    }
  }

  // ---- 纯文本 ----
  const result: ParsedSource[] = [];
  trimmed.split(/\r?\n/).forEach((line) => {
    const row = line.trim();
    if (!row || row.startsWith('#')) return;
    const parts = row.split('|').map((p) => p.trim());
    if (parts.length >= 2) {
      const api = normalizeApi(parts[1]);
      if (!api) return;
      result.push({
        key: keyFromApi(api),
        name: parts[0] || keyFromApi(api),
        api,
      });
    } else if (/^https?:\/\//i.test(row)) {
      const api = normalizeApi(row);
      result.push({ key: keyFromApi(api), name: keyFromApi(api), api });
    }
  });
  return result;
}

/** 以带超时的方式探测单个源是否可用 */
async function probeSource(api: string, timeoutMs = 5000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const u = new URL(api);
    u.searchParams.set('ac', 'videolist');
    u.searchParams.set('wd', '测试');
    const resp = await fetch(u.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
      },
    });
    if (!resp.ok) return false;
    const body = await resp.text();
    const trimmed = body.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    try {
      const json = JSON.parse(trimmed);
      // 苹果 CMS 正常响应通常包含 list/total/code 字段
      return (
        Array.isArray(json.list) ||
        json.total !== undefined ||
        json.code === 1 ||
        json.code === '1'
      );
    } catch {
      return false;
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 从配置文件中同步移除某个源，避免下次初始化时又被合并回来 */
function dropFromConfigFile(adminConfig: AdminConfig, key: string) {
  try {
    const fileConfig = JSON.parse(adminConfig.ConfigFile || '{}');
    const sites = fileConfig?.api_site;
    if (sites && Object.prototype.hasOwnProperty.call(sites, key)) {
      delete sites[key];
      adminConfig.ConfigFile = JSON.stringify(fileConfig);
    }
  } catch {
    // 配置文件解析失败时忽略，不影响源删除
  }
}

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      {
        error: '不支持本地存储进行管理员配置',
      },
      { status: 400 }
    );
  }

  try {
    const body = (await request.json()) as BaseBody & Record<string, any>;
    const { action } = body;

    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const username = authInfo.username;

    // 基础校验
    const ACTIONS: Action[] = [
      'add',
      'disable',
      'enable',
      'delete',
      'sort',
      'batchDisable',
      'batchEnable',
      'batchDelete',
      'import',
      'check',
    ];
    if (!username || !action || !ACTIONS.includes(action)) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
    }

    // 获取配置与存储
    const adminConfig = await getConfig();
    const storage: IStorage | null = getStorage();

    // 权限与身份校验
    if (username !== process.env.USERNAME) {
      const userEntry = adminConfig.UserConfig.Users.find(
        (u) => u.username === username
      );
      if (!userEntry || userEntry.role !== 'admin' || userEntry.banned) {
        return NextResponse.json({ error: '权限不足' }, { status: 401 });
      }
    }

    switch (action) {
      case 'add': {
        const { key, name, api, detail } = body as {
          key?: string;
          name?: string;
          api?: string;
          detail?: string;
        };
        if (!key || !name || !api) {
          return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
        }
        if (adminConfig.SourceConfig.some((s) => s.key === key)) {
          return NextResponse.json({ error: '该源已存在' }, { status: 400 });
        }
        adminConfig.SourceConfig.push({
          key,
          name,
          api,
          detail,
          from: 'custom',
          disabled: false,
        });
        break;
      }
      case 'disable': {
        const { key } = body as { key?: string };
        if (!key)
          return NextResponse.json({ error: '缺少 key 参数' }, { status: 400 });
        const entry = adminConfig.SourceConfig.find((s) => s.key === key);
        if (!entry)
          return NextResponse.json({ error: '源不存在' }, { status: 404 });
        entry.disabled = true;
        break;
      }
      case 'enable': {
        const { key } = body as { key?: string };
        if (!key)
          return NextResponse.json({ error: '缺少 key 参数' }, { status: 400 });
        const entry = adminConfig.SourceConfig.find((s) => s.key === key);
        if (!entry)
          return NextResponse.json({ error: '源不存在' }, { status: 404 });
        entry.disabled = false;
        break;
      }
      case 'delete': {
        const { key } = body as { key?: string };
        if (!key)
          return NextResponse.json({ error: '缺少 key 参数' }, { status: 400 });
        const idx = adminConfig.SourceConfig.findIndex((s) => s.key === key);
        if (idx === -1)
          return NextResponse.json({ error: '源不存在' }, { status: 404 });
        adminConfig.SourceConfig.splice(idx, 1);
        dropFromConfigFile(adminConfig, key);
        break;
      }
      case 'sort': {
        const { order } = body as { order?: string[] };
        if (!Array.isArray(order)) {
          return NextResponse.json(
            { error: '排序列表格式错误' },
            { status: 400 }
          );
        }
        const map = new Map(adminConfig.SourceConfig.map((s) => [s.key, s]));
        const newList: typeof adminConfig.SourceConfig = [];
        order.forEach((k) => {
          const item = map.get(k);
          if (item) {
            newList.push(item);
            map.delete(k);
          }
        });
        // 未在 order 中的保持原顺序
        adminConfig.SourceConfig.forEach((item) => {
          if (map.has(item.key)) newList.push(item);
        });
        adminConfig.SourceConfig = newList;
        break;
      }
      case 'batchDisable': {
        const { keys } = body as { keys?: string[] };
        if (!Array.isArray(keys) || keys.length === 0) {
          return NextResponse.json({ ok: true, affected: 0 });
        }
        keys.forEach((key) => {
          const entry = adminConfig.SourceConfig.find((s) => s.key === key);
          if (entry) {
            entry.disabled = true;
          }
        });
        break;
      }
      case 'batchEnable': {
        const { keys } = body as { keys?: string[] };
        if (!Array.isArray(keys) || keys.length === 0) {
          return NextResponse.json({ ok: true, affected: 0 });
        }
        keys.forEach((key) => {
          const entry = adminConfig.SourceConfig.find((s) => s.key === key);
          if (entry) {
            entry.disabled = false;
          }
        });
        break;
      }
      case 'batchDelete': {
        const { keys } = body as { keys?: string[] };
        if (!Array.isArray(keys) || keys.length === 0) {
          return NextResponse.json({ ok: true, deleted: 0 });
        }
        keys.forEach((key) => {
          const idx = adminConfig.SourceConfig.findIndex((s) => s.key === key);
          if (idx !== -1) {
            adminConfig.SourceConfig.splice(idx, 1);
            dropFromConfigFile(adminConfig, key);
          }
        });
        break;
      }
      case 'import': {
        const { url } = body as { url?: string };
        if (!url || !/^https?:\/\//i.test(url)) {
          return NextResponse.json(
            { error: '请提供合法的导入地址' },
            { status: 400 }
          );
        }

        let text = '';
        try {
          const resp = await fetch(url, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
          });
          if (!resp.ok) {
            return NextResponse.json(
              { error: `下载源配置失败: HTTP ${resp.status}` },
              { status: 502 }
            );
          }
          text = await resp.text();
        } catch (e) {
          return NextResponse.json(
            { error: `下载源配置失败: ${(e as Error).message}` },
            { status: 502 }
          );
        }

        const parsed = parseSourcePayload(text);
        if (parsed.length === 0) {
          return NextResponse.json(
            { error: '未能从该地址解析出任何视频源' },
            { status: 400 }
          );
        }

        let added = 0;
        let updated = 0;
        let skipped = 0;
        const existingByKey = new Map(
          adminConfig.SourceConfig.map((s) => [s.key, s])
        );
        const existingApis = new Set(
          adminConfig.SourceConfig.map((s) => s.api)
        );

        parsed.forEach((src) => {
          const api = normalizeApi(src.api);
          if (!api) return;
          let key = src.key || keyFromApi(api);

          const byKey = existingByKey.get(key);
          if (byKey) {
            // 同 key 更新
            byKey.name = src.name || byKey.name;
            byKey.api = api;
            byKey.detail = src.detail ?? byKey.detail;
            byKey.from = byKey.from === 'config' ? 'config' : 'custom';
            updated += 1;
            return;
          }
          if (existingApis.has(api)) {
            // 同 API 已存在，跳过
            skipped += 1;
            return;
          }
          // 防 key 冲突
          if (existingByKey.has(key)) {
            key = `${key}-${Math.random().toString(36).slice(2, 6)}`;
          }
          const entry = {
            key,
            name: src.name || keyFromApi(api),
            api,
            detail: src.detail,
            from: 'custom' as const,
            disabled: false,
          };
          adminConfig.SourceConfig.push(entry);
          existingByKey.set(key, entry as any);
          existingApis.add(api);
          added += 1;
        });

        // 导入完成后立即持久化并返回统计
        if (storage && typeof (storage as any).setAdminConfig === 'function') {
          await (storage as any).setAdminConfig(adminConfig);
        }
        return NextResponse.json(
          { ok: true, added, updated, skipped },
          { headers: { 'Cache-Control': 'no-store' } }
        );
      }
      case 'check': {
        const { keys } = body as { keys?: string[] };
        if (!Array.isArray(keys) || keys.length === 0) {
          return NextResponse.json({ ok: true, results: [] });
        }
        const targets = adminConfig.SourceConfig.filter((s) =>
          keys.includes(s.key)
        );
        // 并发探测，最多 8 个同时进行
        const results: { key: string; ok: boolean }[] = [];
        const concurrency = 8;
        for (let i = 0; i < targets.length; i += concurrency) {
          const batch = targets.slice(i, i + concurrency);
          const settled = await Promise.all(
            batch.map(async (s) => ({
              key: s.key,
              ok: await probeSource(s.api),
            }))
          );
          results.push(...settled);
        }
        return NextResponse.json(
          { ok: true, results },
          { headers: { 'Cache-Control': 'no-store' } }
        );
      }
      default:
        return NextResponse.json({ error: '未知操作' }, { status: 400 });
    }

    // 持久化到存储
    if (storage && typeof (storage as any).setAdminConfig === 'function') {
      await (storage as any).setAdminConfig(adminConfig);
    }

    return NextResponse.json(
      { ok: true },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch (error) {
    console.error('视频源管理操作失败:', error);
    return NextResponse.json(
      {
        error: '视频源管理操作失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}

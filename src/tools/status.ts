// roon_status: how Deep Roon MCP stands — for the user, and for a bug report.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { version } from '../../package.json';
import { findTarget } from '../core/session';
import { isPaired, paired as waitPaired } from '../core/official';
import { selfTest, selfTestResults, updateInfo, updateLine, selfTestSettling } from '../core/status';
import { runSelfTest } from '../roon/selftest';
import { run } from './run';
import { z } from 'zod';
import { withCore } from '../core/session';
import type { Any } from '../roon/graph';

/** A measuring tool for development (DEEP_ROON_DEBUG=1 only): the graph's type names with counts, or the objects of one type
 *  with their field names and a short preview — to learn what Roon's objects carry before building a tool on them (13 Oct 2026). */
function registerDebugTool(server: McpServer): void {
  server.registerTool('roon_debug', {
    title: 'Graph fields (development)',
    description: 'Development only: without `type`, the graph\'s type names with counts (`match` narrows); with `type`, the first `limit` objects of that type with their fields.',
    inputSchema: { type: z.string().optional(), match: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  }, ({ type, match, limit }) => run(() => withCore(async (c) => {
    const preview = (v: Any): Any => {
      if (v && typeof v === 'object' && '$ref' in v) { const o = c.graph.getObject(v.$ref); return { $ref: String(v.$ref), type: o?.typeName }; }
      if (Array.isArray(v)) return v.slice(0, 3).map(preview);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 6).map(([k, x]) => [k, preview(x)]));
      return typeof v === 'string' ? v.slice(0, 80) : typeof v === 'bigint' ? String(v) : v;
    };
    if (!type) {
      const counts = new Map<string, number>();
      for (const o of ((c.graph as Any).objects as Map<string, Any>).values()) counts.set(o.typeName, (counts.get(o.typeName) ?? 0) + 1);
      return { types: [...counts].filter(([n]) => !match || n.toLowerCase().includes(match.toLowerCase())).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })) };
    }
    const all = c.graph.findByType(type);
    return { count: all.length, objects: all.slice(0, limit ?? 3).map((o) => ({ oid: String(o.oid), type: o.typeName,
      fields: Object.fromEntries(Object.entries(o.fields ?? {}).map(([k, v]) => [k.replace(/^.*::/, ''), preview(v)])) })) };
  })));
}

export function registerStatusTool(server: McpServer, internal: boolean): void {
  if (process.env.DEEP_ROON_DEBUG === '1') registerDebugTool(server);
  server.registerTool('roon_status', {
    title: 'Deep Roon MCP status',
    description: 'How Deep Roon MCP stands: its version (and whether it is up to date or a newer one is out), the Roon Core it talks to, whether it is enabled in Roon (Settings › Extensions), whether Roon\'s internal protocol works, and a self-test of a few reads with the tools each one stands for. Use it when a tool fails, or when the user asks whether everything works.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => run(async () => {
    const t = await findTarget().catch((e: Error) => ({ error: e.message }));
    const core = 'error' in t ? { error: t.error } : { name: t.info.name, version: t.info.version, address: t.host };
    if (!('error' in t)) await waitPaired(5000).catch(() => null);   // a fresh start pairs within a second or two
    const paired = isPaired();
    const settling = selfTestSettling();
    if (internal && paired && !selfTestResults() && settling === 0) await selfTest(runSelfTest);
    const checks = selfTestResults();
    return {
      deep_roon_mcp: version, update: updateLine(), newer_version: updateInfo() ?? undefined,
      core, enabled_in_roon: paired || 'not yet: Roon › Settings › Extensions › Enable next to "Deep Roon MCP"',
      internal_protocol: internal ? (checks ? (checks.every((c) => c.ok) ? 'works' : 'partly broken — see self_test')
        : settling > 0 ? `the Core just updated — the self-test runs again in about ${Math.ceil(settling / 60)} min, once Roon has settled`
        : 'not tested yet') : 'switched off (only the official API)',
      self_test: checks ?? undefined,
    };
  }));
}

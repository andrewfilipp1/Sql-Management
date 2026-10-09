import type { SchemaSnapshot, TableInfo } from '../../shared/types';
import { KIND_LABEL } from '../../shared/types';
import { nodeId, relationsOf } from './utils';

/** Escape for HTML text and attribute values — schema names and comments are untrusted text. */
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const anchor = (t: TableInfo) => 't-' + nodeId(t).replace(/[^A-Za-z0-9_-]/g, '-');

export function docsHtml(s: SchemaSnapshot, title: string): string {
  const rels = relationsOf(s);
  const tables = [...s.tables].sort((a, b) => nodeId(a).localeCompare(nodeId(b)));
  const section = (t: TableInfo) => {
    const fks = new Set(t.foreignKeys.flatMap((f) => f.columns));
    const incoming = rels.filter((r) => r.to === t && r.from !== t);
    return `
<section id="${anchor(t)}">
  <h2>${esc(nodeId(t))} <span class="tag">${t.type}</span>${t.rowCount != null ? ` <span class="muted">${t.rowCount.toLocaleString('en-US')} rows</span>` : ''}</h2>
  <table>
    <thead><tr><th></th><th>Column</th><th>Type</th><th>Nullable</th><th>Default</th><th>Description</th></tr></thead>
    <tbody>
      ${t.columns
        .map(
          (c) => `<tr><td class="key">${c.isPrimaryKey ? 'PK' : fks.has(c.name) ? 'FK' : ''}</td><td class="mono">${esc(c.name)}</td><td class="mono">${esc(c.type)}</td><td>${c.nullable ? 'yes' : 'no'}</td><td class="mono">${esc(c.default ?? '')}</td><td>${esc(c.comment ?? '')}</td></tr>`,
        )
        .join('\n      ')}
    </tbody>
  </table>
  ${
    t.foreignKeys.length
      ? `<h3>References</h3><ul>${t.foreignKeys
          .map((f) => {
            const target = s.tables.find((x) => x.name === f.refTable && (f.refSchema === undefined || x.schema === f.refSchema));
            const label = `${esc(f.refTable)}(${esc(f.refColumns.join(', '))})`;
            return `<li><span class="mono">${esc(f.columns.join(', '))}</span> → ${target ? `<a href="#${anchor(target)}">${label}</a>` : label}${f.onDelete && f.onDelete !== 'NO ACTION' ? ` <span class="muted">on delete ${esc(f.onDelete)}</span>` : ''}</li>`;
          })
          .join('')}</ul>`
      : ''
  }
  ${incoming.length ? `<h3>Referenced by</h3><ul>${incoming.map((r) => `<li><a href="#${anchor(r.from)}">${esc(nodeId(r.from))}</a> <span class="mono">(${esc(r.fromColumns.join(', '))})</span></li>`).join('')}</ul>` : ''}
  ${t.indexes.length ? `<h3>Indexes</h3><ul>${t.indexes.map((i) => `<li class="mono">${esc(i.name)} (${esc(i.columns.join(', '))})${i.unique ? ' <span class="tag">unique</span>' : ''}</li>`).join('')}</ul>` : ''}
</section>`;
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg:#fff; --fg:#172033; --muted:#64708a; --line:#e3e7f0; --accent:#4f46e5; --chip:#eef0ff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0e1a; --fg:#e8eaf6; --muted:#959bbb; --line:#232a44; --accent:#a5b4fc; --chip:#1c2140; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  .wrap { display:grid; grid-template-columns: 260px 1fr; min-height:100vh; }
  nav { border-right:1px solid var(--line); padding:20px; position:sticky; top:0; height:100vh; overflow:auto; box-sizing:border-box; }
  nav a { display:block; color:var(--fg); text-decoration:none; padding:2px 0; font-family:ui-monospace, monospace; font-size:12.5px; }
  nav a:hover { color:var(--accent); }
  main { padding:28px 40px; max-width:1100px; }
  h1 { margin:0 0 4px; } h2 { margin:36px 0 10px; font-size:18px; } h3 { font-size:13px; margin:14px 0 4px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; color:var(--muted); font-weight:600; }
  .mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; }
  .key { font-weight:700; color:var(--accent); width:28px; }
  .tag { font-size:11px; background:var(--chip); color:var(--accent); padding:1px 6px; border-radius:6px; font-weight:500; }
  .muted { color:var(--muted); font-size:12px; font-weight:400; }
  a { color:var(--accent); }
  @media print { nav { display:none; } .wrap { display:block; } }
  @media (max-width: 760px) { .wrap { display:block; } nav { position:static; height:auto; border-right:0; border-bottom:1px solid var(--line); } main { padding:20px 16px; } }
</style></head>
<body><div class="wrap">
<nav><strong>Tables</strong>${tables.map((t) => `<a href="#${anchor(t)}">${esc(nodeId(t))}</a>`).join('')}</nav>
<main>
  <h1>${esc(title)}</h1>
  <p class="muted">${esc(KIND_LABEL[s.kind])} · ${tables.length} tables and views · ${rels.length} relationships · generated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} by SchemaScope</p>
  ${tables.map(section).join('\n')}
</main></div></body></html>`;
}

/** Mermaid identifiers must be plain words. */
const mid = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');

export function docsMarkdown(s: SchemaSnapshot, title: string): string {
  const rels = relationsOf(s);
  const tables = [...s.tables].sort((a, b) => nodeId(a).localeCompare(nodeId(b)));
  const md: string[] = [`# ${title}`, '', `${KIND_LABEL[s.kind]} · ${tables.length} tables and views · ${rels.length} relationships`, ''];
  md.push('```mermaid', 'erDiagram');
  for (const r of rels) {
    const nullable = r.fromColumns.some((c) => r.from.columns.find((x) => x.name === c)?.nullable);
    md.push(`  ${mid(nodeId(r.to))} ||--${nullable ? 'o' : '|'}{ ${mid(nodeId(r.from))} : "${r.fromColumns.join(', ').replace(/"/g, "'")}"`);
  }
  for (const t of tables) {
    const fks = new Set(t.foreignKeys.flatMap((f) => f.columns));
    md.push(`  ${mid(nodeId(t))} {`);
    for (const c of t.columns) md.push(`    ${mid(c.type.split('(')[0]) || 'unknown'} ${mid(c.name)}${c.isPrimaryKey ? ' PK' : fks.has(c.name) ? ' FK' : ''}`);
    md.push('  }');
  }
  md.push('```', '');
  const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const t of tables) {
    const fks = new Set(t.foreignKeys.flatMap((f) => f.columns));
    md.push(`## ${nodeId(t)}${t.type === 'view' ? ' (view)' : ''}`, '');
    if (t.rowCount != null) md.push(`${t.rowCount.toLocaleString('en-US')} rows`, '');
    md.push('| | Column | Type | Nullable | Default |', '|---|---|---|---|---|');
    for (const c of t.columns) md.push(`| ${c.isPrimaryKey ? 'PK' : fks.has(c.name) ? 'FK' : ''} | \`${cell(c.name)}\` | ${cell(c.type)} | ${c.nullable ? 'yes' : 'no'} | ${cell(c.default)} |`);
    if (t.foreignKeys.length) {
      md.push('', '**References**', '');
      for (const f of t.foreignKeys) md.push(`- \`${f.columns.join(', ')}\` → ${f.refTable}(${f.refColumns.join(', ')})`);
    }
    md.push('');
  }
  return md.join('\n');
}

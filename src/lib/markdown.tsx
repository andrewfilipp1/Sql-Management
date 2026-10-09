import type { ReactNode } from 'react';

/**
 * Small Markdown renderer for notebook text cells. It builds React elements only, so any HTML
 * in the source is shown as text. Supports headings, lists, quotes, code blocks, inline code,
 * bold, italic and http(s) links.
 */
export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(
        <pre key={key++} className="my-2 overflow-auto rounded-lg border border-line bg-black/30 px-3 py-2 font-mono text-[12px] text-cyan-50">
          {body.join('\n')}
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const size = ['text-xl', 'text-lg', 'text-base', 'text-sm'][h[1].length - 1];
      out.push(
        <div key={key++} role="heading" aria-level={h[1].length} className={`${size} mt-2 mb-1 font-semibold tracking-tight`}>
          {inline(h[2])}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List key={key++} className={`my-1.5 space-y-0.5 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-faint`}>
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(
        <blockquote key={key++} className="my-2 border-l-2 border-accent/50 pl-3 text-muted">
          {inline(body.join(' '))}
        </blockquote>,
      );
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push(<hr key={key++} className="my-3 border-line" />);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
    out.push(
      <p key={key++} className="my-1.5 leading-relaxed">
        {inline(para.join(' '))}
      </p>,
    );
  }
  return out;
}

function inline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g);
  return parts.map((p, i) => {
    if (p.length > 2 && p.startsWith('`') && p.endsWith('`')) {
      return (
        <code key={i} className="rounded bg-white/10 px-1 font-mono text-[0.9em] text-cyan-200">
          {p.slice(1, -1)}
        </code>
      );
    }
    if (p.length > 4 && p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{inline(p.slice(2, -2))}</strong>;
    if (p.length > 2 && p.startsWith('*') && p.endsWith('*')) return <em key={i}>{p.slice(1, -1)}</em>;
    const link = p.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      // Only web links; anything else (javascript:, file:…) stays text.
      return /^https?:\/\//i.test(link[2]) ? (
        <a key={i} href={link[2]} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
          {link[1]}
        </a>
      ) : (
        p
      );
    }
    return p;
  });
}

import { ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/utils';
import { Input } from './ui';

/**
 * Column-type field: free text plus a dropdown of common types. Unlike a native <datalist>,
 * opening it shows every type; the list narrows only once the user types.
 */
export function TypeInput({ value, onChange, types, className }: { value: string; onChange: (v: string) => void; types: string[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0 });
  const wrap = useRef<HTMLDivElement>(null);

  const q = value.trim().toLowerCase();
  const filtered = typed && q ? types.filter((t) => t.toLowerCase().includes(q)) : types;
  const shown = filtered.length ? filtered : types;

  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const r = wrap.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const height = Math.min(240, shown.length * 26 + 8);
    setPos({ left: r.left, top: below < height + 8 ? r.top - height - 4 : r.bottom + 4, width: Math.max(r.width, 160) });
  }, [open, shown.length]);

  // The list is positioned once; close it if anything scrolls or resizes underneath.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => !(e.target instanceof Node && document.querySelector('[data-type-list]')?.contains(e.target)) && setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const show = () => {
    setTyped(false);
    setActive(Math.max(0, types.findIndex((t) => t.toLowerCase() === q)));
    setOpen(true);
  };
  const pick = (t: string) => {
    onChange(t);
    setOpen(false);
  };

  return (
    <div ref={wrap} className="relative">
      <Input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(true);
          setActive(0);
          setOpen(true);
        }}
        onFocus={show}
        onClick={() => !open && show()}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) return show();
            const d = e.key === 'ArrowDown' ? 1 : -1;
            setActive((a) => (a + d + shown.length) % shown.length);
          } else if (e.key === 'Enter' && open) {
            e.preventDefault();
            pick(shown[active] ?? value);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        className={cn('pr-7', className)}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Show types"
        title="Show types"
        onMouseDown={(e) => {
          e.preventDefault();
          if (open) setOpen(false);
          else {
            (wrap.current?.querySelector('input') as HTMLInputElement | null)?.focus();
            show();
          }
        }}
        className="absolute inset-y-0 right-1 flex items-center px-1 text-faint hover:text-muted"
      >
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open &&
        createPortal(
          <div
            role="listbox"
            data-type-list
            style={{ left: pos.left, top: pos.top, width: pos.width }}
            className="fixed z-[70] max-h-60 border border-line bg-[#0e1120] overflow-y-auto rounded-lg p-1 shadow-[var(--shadow)]"
            onMouseDown={(e) => e.preventDefault()}
          >
            {shown.map((t, i) => (
              <div
                key={t}
                role="option"
                aria-selected={i === active}
                ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(t)}
                className={cn(
                  'cursor-pointer rounded-md px-2 py-1 font-mono text-xs',
                  i === active ? 'bg-accent-soft text-fg' : 'text-muted',
                  t.toLowerCase() === q && 'font-semibold text-fg',
                )}
              >
                {t}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

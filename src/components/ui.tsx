import { AnimatePresence, motion, type HTMLMotionProps, type Transition } from 'motion/react';
import { Loader2, X } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/utils';

export const spring: Transition = { type: 'spring', stiffness: 420, damping: 30, mass: 0.8 };
export const softSpring: Transition = { type: 'spring', stiffness: 260, damping: 30 };

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-gradient-to-b from-indigo-400 to-indigo-600 text-white border border-indigo-300/30 shadow-[0_0_20px_-4px_rgb(129_140_248/0.7)] hover:shadow-[0_0_28px_-2px_rgb(129_140_248/0.9)]',
  secondary: 'glass text-fg hover:border-line-strong hover:shadow-[0_0_18px_-6px_rgb(129_140_248/0.6)]',
  ghost: 'text-muted hover:text-fg hover:bg-white/5 border border-transparent',
  danger:
    'bg-rose-500/15 text-rose-300 border border-rose-400/30 hover:bg-rose-500/25 hover:shadow-[0_0_22px_-4px_rgb(251_113_133/0.7)]',
};

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  loading?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, children, className, disabled, ...rest },
  ref,
) {
  return (
    <motion.button
      ref={ref}
      whileHover={disabled ? undefined : { scale: 1.03 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={spring}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-[box-shadow,background-color,border-color,color] duration-200 disabled:opacity-45',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </motion.button>
  );
});

export function IconButton({
  label,
  children,
  className,
  active,
  ...rest
}: Omit<HTMLMotionProps<'button'>, 'children'> & { label: string; active?: boolean; children: ReactNode }) {
  return (
    <motion.button
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.92 }}
      transition={spring}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-40',
        active ? 'bg-accent-soft text-accent shadow-[0_0_14px_-4px_rgb(129_140_248/0.8)]' : 'text-muted hover:bg-white/6 hover:text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </motion.button>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }>(
  function Input({ className, icon, ...rest }, ref) {
    const input = (
      <input
        ref={ref}
        className={cn(
          'h-8 w-full rounded-lg border border-line bg-black/25 px-2.5 text-[13px] text-fg placeholder:text-faint outline-none transition-[border-color,box-shadow]',
          'focus:border-accent/60 focus:shadow-[0_0_0_3px_rgb(129_140_248/0.15),0_0_18px_-6px_rgb(129_140_248/0.6)]',
          icon ? 'pl-8' : '',
          className,
        )}
        {...rest}
      />
    );
    if (!icon) return input;
    return (
      <div className="relative w-full">
        <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint">{icon}</span>
        {input}
      </div>
    );
  },
);

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-8 rounded-lg border border-line bg-black/25 px-2 text-[13px] text-fg outline-none focus:border-accent/60',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-fg select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3.5 rounded accent-indigo-400"
      />
      {label}
    </label>
  );
}

export function Badge({ children, tone = 'default', className }: { children: ReactNode; tone?: 'default' | 'accent' | 'pk' | 'fk' | 'ok' | 'warn' | 'danger'; className?: string }) {
  const tones = {
    default: 'bg-white/6 text-muted border-line',
    accent: 'bg-accent-soft text-accent border-accent/25',
    pk: 'bg-amber-400/10 text-pk border-amber-400/25',
    fk: 'bg-cyan-400/10 text-fk border-cyan-400/25',
    ok: 'bg-emerald-400/10 text-ok border-emerald-400/25',
    warn: 'bg-amber-400/10 text-warn border-amber-400/25',
    danger: 'bg-rose-400/10 text-danger border-rose-400/25',
  };
  return (
    <span className={cn('inline-flex h-[18px] items-center gap-1 rounded-md border px-1.5 text-[10.5px] font-medium', tones[tone], className)}>
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-accent', className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-white/5 px-1 py-px font-mono text-[10px] text-muted">{children}</kbd>
  );
}

export function Modal({
  open,
  onClose,
  title,
  icon,
  children,
  footer,
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div className="absolute inset-0 bg-[#03040a]/70 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={spring}
            style={{ width }}
            className="glass-strong gradient-border relative flex max-h-[88vh] max-w-full flex-col rounded-2xl shadow-[var(--shadow)]"
          >
            <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5">
              {icon && <span className="text-accent">{icon}</span>}
              <h2 className="flex-1 text-[15px] font-semibold">{title}</h2>
              <IconButton label="Close" onClick={onClose}>
                <X className="size-4" />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
            {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  layoutId,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; icon?: ReactNode }[];
  layoutId: string;
}) {
  return (
    <div className="glass inline-flex rounded-lg p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'relative flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
            value === o.value ? 'text-fg' : 'text-muted hover:text-fg',
          )}
        >
          {value === o.value && (
            <motion.span
              layoutId={layoutId}
              transition={spring}
              className="absolute inset-0 rounded-md bg-accent-soft shadow-[0_0_16px_-4px_rgb(129_140_248/0.7)] ring-1 ring-accent/30"
            />
          )}
          <span className="relative flex items-center gap-1.5">
            {o.icon}
            {o.label}
          </span>
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={softSpring}
      className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <div className="glass glow flex size-14 items-center justify-center rounded-2xl text-accent">{icon}</div>
      <div className="text-[15px] font-semibold">{title}</div>
      {children && <div className="max-w-sm text-[13px] text-muted">{children}</div>}
    </motion.div>
  );
}

// ---------- Context menu ----------

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  hint?: string;
}

const MenuContext = createContext<(e: { clientX: number; clientY: number }, items: MenuItem[]) => void>(() => {});

export function useContextMenu() {
  return useContext(MenuContext);
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const open = useCallback((e: { clientX: number; clientY: number }, items: MenuItem[]) => {
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 8),
      y: Math.min(menu.y, window.innerHeight - r.height - 8),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  return (
    <MenuContext.Provider value={open}>
      {children}
      {createPortal(
        <AnimatePresence>
          {menu && (
            <motion.div
              ref={ref}
              initial={{ opacity: 0, scale: 0.95, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.12 }}
              style={{ left: pos.x, top: pos.y, transformOrigin: 'top left' }}
              className="glass-strong fixed z-[60] min-w-[200px] rounded-xl p-1 shadow-[var(--shadow)]"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {menu.items.map((it, i) =>
                it.separator ? (
                  <div key={i} className="my-1 h-px bg-line" />
                ) : (
                  <button
                    key={i}
                    disabled={it.disabled}
                    onClick={() => {
                      setMenu(null);
                      it.onClick?.();
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:opacity-40',
                      it.danger ? 'text-rose-300 hover:bg-rose-500/15' : 'text-fg hover:bg-accent-soft',
                    )}
                  >
                    <span className="flex size-4 items-center justify-center text-muted">{it.icon}</span>
                    <span className="flex-1">{it.label}</span>
                    {it.hint && <span className="text-[11px] text-faint">{it.hint}</span>}
                  </button>
                ),
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </MenuContext.Provider>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-[background-color,box-shadow,border-color] duration-300 disabled:opacity-40',
        checked
          ? 'border-indigo-300/40 bg-indigo-500/70 shadow-[0_0_16px_-2px_rgb(129_140_248/0.8)]'
          : 'border-line-strong bg-white/8',
      )}
    >
      <motion.span
        layout
        transition={spring}
        className={cn('size-3.5 rounded-full bg-white shadow', checked ? 'ml-[18px]' : 'ml-[3px]')}
      />
    </button>
  );
}

export function CopyField({ value, mono = true, secret }: { value: string; mono?: boolean; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch overflow-hidden rounded-lg border border-line bg-black/30">
      <code className={cn('min-w-0 flex-1 overflow-x-auto px-2.5 py-1.5 text-[12px] whitespace-pre text-fg/90', mono && 'font-mono', secret && 'text-amber-100')}>
        {value}
      </code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        className="shrink-0 border-l border-line px-2.5 text-[11px] font-medium text-muted transition-colors hover:bg-white/5 hover:text-fg"
      >
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  );
}

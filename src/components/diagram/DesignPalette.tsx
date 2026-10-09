import { motion } from 'motion/react';
import { Braces, Calendar, CalendarClock, CaseSensitive, Fingerprint, Hash, Key, Link2, Mail, Percent, Table2, ToggleLeft, Type } from 'lucide-react';
import type { ReactNode } from 'react';
import type { DbKind } from '../../../shared/types';
import type { ColDraft } from '../../lib/designer';
import { typeFor } from '../../lib/schemaDiff';
import { spring } from '../ui';

export const DND_TYPE = 'application/x-schemascope';

export type PaletteItem = { kind: 'table' } | { kind: 'column'; template: string } | { kind: 'fk' };

interface Template {
  id: string;
  label: string;
  icon: ReactNode;
  make: (kind: DbKind) => ColDraft;
}

const ic = 'size-3.5';
export const COLUMN_TEMPLATES: Template[] = [
  { id: 'id', label: 'ID (primary key)', icon: <Key className={`${ic} text-pk`} />, make: (k) => ({ name: 'id', type: k === 'sqlite' ? 'INTEGER' : typeFor(k, 'int'), nullable: false, pk: true, identity: true }) },
  { id: 'name', label: 'Name', icon: <CaseSensitive className={ic} />, make: (k) => ({ name: 'name', type: typeFor(k, 'varchar', '255'), nullable: false, pk: false, identity: false }) },
  { id: 'text', label: 'Text', icon: <Type className={ic} />, make: (k) => ({ name: 'description', type: typeFor(k, 'text'), nullable: true, pk: false, identity: false }) },
  { id: 'email', label: 'Email', icon: <Mail className={ic} />, make: (k) => ({ name: 'email', type: typeFor(k, 'varchar', '255'), nullable: false, pk: false, identity: false }) },
  { id: 'int', label: 'Integer', icon: <Hash className={ic} />, make: (k) => ({ name: 'quantity', type: typeFor(k, 'int'), nullable: true, pk: false, identity: false }) },
  { id: 'decimal', label: 'Decimal', icon: <Percent className={ic} />, make: (k) => ({ name: 'amount', type: typeFor(k, 'decimal', '10,2'), nullable: true, pk: false, identity: false }) },
  { id: 'bool', label: 'Yes / no', icon: <ToggleLeft className={ic} />, make: (k) => ({ name: 'is_active', type: typeFor(k, 'bool'), nullable: true, pk: false, identity: false }) },
  { id: 'date', label: 'Date', icon: <Calendar className={ic} />, make: (k) => ({ name: 'date', type: typeFor(k, 'date'), nullable: true, pk: false, identity: false }) },
  {
    id: 'created',
    label: 'Created at',
    icon: <CalendarClock className={ic} />,
    make: (k) => ({ name: 'created_at', type: typeFor(k, 'datetime'), nullable: false, pk: false, identity: false, default: 'CURRENT_TIMESTAMP' }),
  },
  { id: 'uuid', label: 'UUID', icon: <Fingerprint className={ic} />, make: (k) => ({ name: 'uuid', type: typeFor(k, 'uuid'), nullable: true, pk: false, identity: false }) },
  { id: 'json', label: 'JSON', icon: <Braces className={ic} />, make: (k) => ({ name: 'data', type: typeFor(k, 'json'), nullable: true, pk: false, identity: false }) },
];

function Chip({ item, icon, label, hint, accent }: { item: PaletteItem; icon: ReactNode; label: string; hint?: string; accent?: boolean }) {
  return (
    <motion.div
      draggable
      onDragStart={(e) => {
        const ev = e as unknown as React.DragEvent;
        ev.dataTransfer.setData(DND_TYPE, JSON.stringify(item));
        ev.dataTransfer.effectAllowed = 'copy';
      }}
      whileHover={{ scale: 1.04, x: 2 }}
      whileTap={{ scale: 0.96 }}
      transition={spring}
      title={hint}
      className={
        accent
          ? 'flex cursor-grab items-center gap-2 rounded-lg border border-emerald-300/40 bg-emerald-400/10 px-2.5 py-2 text-[12.5px] font-medium text-emerald-100 shadow-[0_0_18px_-6px_rgb(52_211_153/0.9)] active:cursor-grabbing'
          : 'flex cursor-grab items-center gap-2 rounded-lg border border-line bg-white/[0.03] px-2 py-1.5 text-[12px] text-fg/85 hover:border-cyan-300/40 hover:text-fg hover:shadow-[0_0_14px_-6px_rgb(34_211_238/0.8)] active:cursor-grabbing'
      }
    >
      <span className="flex w-4 justify-center text-muted">{icon}</span>
      {label}
    </motion.div>
  );
}

export function DesignPalette() {
  return (
    <motion.div
      initial={{ opacity: 0, x: -24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -24 }}
      transition={spring}
      className="glass absolute top-[68px] left-3 z-10 flex max-h-[calc(100%-150px)] w-48 flex-col gap-1.5 overflow-auto rounded-xl p-2 shadow-[var(--shadow)]"
    >
      <div className="px-1 pb-0.5 text-[10.5px] font-semibold tracking-wider text-muted uppercase">Drag onto the canvas</div>
      <Chip item={{ kind: 'table' }} icon={<Table2 className="size-4" />} label="New table" hint="Drop on an empty spot" accent />
      <div className="px-1 pt-2 pb-0.5 text-[10.5px] font-semibold tracking-wider text-muted uppercase">Onto a table</div>
      {COLUMN_TEMPLATES.map((t) => (
        <Chip key={t.id} item={{ kind: 'column', template: t.id }} icon={t.icon} label={t.label} hint="Drop onto a table to add this column" />
      ))}
      <Chip item={{ kind: 'fk' }} icon={<Link2 className={`${ic} text-fk`} />} label="Reference to…" hint="Drop onto a table, then choose the table it points to" />
      <p className="px-1 pt-1 text-[10.5px] leading-snug text-faint">
        Or drag from a column to another table’s column to relate them. Double-click names and types to edit.
      </p>
    </motion.div>
  );
}

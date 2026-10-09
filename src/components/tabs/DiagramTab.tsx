import { motion } from 'motion/react';
import { Waypoints } from 'lucide-react';
import { useEffect } from 'react';
import { openTable, refreshSchema } from '../../lib/actions';
import { useSchema, useStore, type Tab } from '../../lib/store';
import { SchemaVisualizer } from '../diagram/SchemaVisualizer';
import { EmptyState } from '../ui';

export function DiagramTab({ tab }: { tab: Tab }) {
  const state = useSchema(tab.connId, tab.database);
  const ensureSchema = useStore((s) => s.ensureSchema);
  useEffect(() => ensureSchema(tab.connId, tab.database), [tab.connId, tab.database, ensureSchema]);

  if (state?.status === 'error') {
    return <EmptyState icon={<Waypoints className="size-6" />} title="Could not read the schema">{state.error}</EmptyState>;
  }
  if (!state?.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
          className="pulse-ring flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent"
        >
          <Waypoints className="size-6" />
        </motion.div>
        <div className="text-sm text-muted">Reading schema…</div>
      </div>
    );
  }
  if (!state.data.tables.length) {
    return (
      <EmptyState icon={<Waypoints className="size-6" />} title="No tables yet">
        This database is empty. Create a table from the sidebar to see it here.
      </EmptyState>
    );
  }
  return (
    <SchemaVisualizer
      connId={tab.connId}
      database={tab.database}
      schema={state.data}
      initialFocus={tab.focus}
      onOpenTable={(t) => openTable(tab.connId, tab.database, t)}
      onRefresh={() => refreshSchema(tab.connId, tab.database)}
    />
  );
}

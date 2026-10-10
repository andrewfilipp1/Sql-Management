import { motion } from 'motion/react';
import { ArrowRight, Database, DatabaseZap, Plus, Server, Sparkles, Waypoints } from 'lucide-react';
import { KIND_LABEL } from '../../shared/types';
import { openDiagram } from '../lib/actions';
import { useStore } from '../lib/store';
import { DbIcon } from './DbIcon';
import { Button, Kbd, softSpring, spring } from './ui';

export function Welcome() {
  const connections = useStore((s) => s.connections);
  const openConnectionDialog = useStore((s) => s.openConnectionDialog);
  const connect = useStore((s) => s.connect);

  const openConn = async (id: string) => {
    const s = await connect(id);
    if (s) {
      useStore.getState().toggle(id, true);
      openDiagram(id, s.defaultDatabase);
    }
  };

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden">
      {/* orbiting glow */}
      <motion.div
        aria-hidden
        animate={{ rotate: 360 }}
        transition={{ duration: 40, repeat: Infinity, ease: 'linear' }}
        className="pointer-events-none absolute size-[720px] rounded-full opacity-60"
        style={{ background: 'conic-gradient(from 0deg, transparent, rgb(129 140 248 / 0.18), transparent 30%, rgb(34 211 238 / 0.14), transparent 60%)', filter: 'blur(60px)' }}
      />
      <div className="relative w-full max-w-2xl px-8">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={softSpring} className="text-center">
          <motion.div
            initial={{ scale: 0.4, rotate: -40 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ ...spring, delay: 0.1 }}
            className="mx-auto mb-6 flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-400 to-cyan-400 shadow-[0_0_50px_-6px_rgb(129_140_248/0.9)]"
          >
            <Waypoints className="size-8 text-white" />
          </motion.div>
          <h1 className="glow-text text-3xl font-semibold tracking-tight">SQL Graphic Tool</h1>
          <p className="mx-auto mt-3 max-w-md text-[14px] text-muted">
            See how your database fits together. Explore tables and relationships visually, browse and edit data, and run SQL — on
            SQLite, SQL Server, PostgreSQL and MySQL.
          </p>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ ...softSpring, delay: 0.15 }} className="mt-8">
          {connections.length > 0 && (
            <div className="mb-3 text-[11px] font-semibold tracking-wider text-muted uppercase">Your connections</div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {connections.slice(0, 6).map((c, i) => (
              <motion.button
                key={c.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.98 }}
                transition={{ ...spring, delay: 0.2 + i * 0.05 }}
                onClick={() => void openConn(c.id)}
                className="glass group flex items-center gap-3 rounded-xl p-3 text-left hover:border-line-strong hover:shadow-[0_0_28px_-10px_rgb(129_140_248/0.8)]"
              >
                <DbIcon kind={c.kind} color={c.color} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{c.name}</div>
                  <div className="truncate text-[11px] text-faint">{KIND_LABEL[c.kind]}</div>
                </div>
                <ArrowRight className="size-4 text-faint transition-transform group-hover:translate-x-1 group-hover:text-accent" />
              </motion.button>
            ))}
          </div>
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => openConnectionDialog()}>
              New connection
            </Button>
            <Button icon={<DatabaseZap className="size-4" />} onClick={() => useStore.getState().openNewDatabase(true)} data-testid="welcome-new-db">
              New database
            </Button>
            <Button variant="ghost" icon={<Server className="size-4" />} onClick={() => useStore.getState().openLocalServer()}>
              Local SQL Server
            </Button>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="mt-10 grid grid-cols-3 gap-3 text-[12px] text-muted"
        >
          <Tip icon={<Waypoints className="size-3.5" />}>Click a table in the diagram to open its live data drawer.</Tip>
          <Tip icon={<Sparkles className="size-3.5" />}>Hover a table to light up every relationship it has.</Tip>
          <Tip icon={<Database className="size-3.5" />}>
            Run queries with <Kbd>⌘/Ctrl</Kbd> + <Kbd>Enter</Kbd>.
          </Tip>
        </motion.div>
      </div>
    </div>
  );
}

function Tip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="glass rounded-xl p-3">
      <div className="mb-1.5 text-accent">{icon}</div>
      {children}
    </div>
  );
}

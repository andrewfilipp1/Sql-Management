import { BookOpen } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { docsHtml, docsMarkdown } from '../../lib/docs';
import { useConnection, useSchema, useStore } from '../../lib/store';
import { Button, Modal, Segmented } from '../ui';

export function DocsDialog() {
  const d = useStore((s) => s.dbDialog);
  const open = d?.kind === 'docs';
  const close = () => useStore.getState().openDbDialog(null);
  const conn = useConnection(d?.connId ?? '');
  const schema = useSchema(d?.connId ?? '', d?.database ?? '')?.data;
  const [format, setFormat] = useState<'html' | 'md'>('html');

  const save = async () => {
    if (!schema || !d) return;
    const title = `${conn?.name ?? 'Database'} — ${d.database}`;
    const content = format === 'html' ? docsHtml(schema, title) : docsMarkdown(schema, title);
    if (await api.saveTextFile(`${d.database}-schema.${format}`, content)) {
      useStore.getState().toast('Documentation saved', 'success');
      close();
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Generate documentation"
      icon={<BookOpen className="size-4" />}
      width={500}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!schema} onClick={() => void save()}>
            Save…
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[13px] text-muted">
          A reference of every table and view: columns, types, keys, relationships, indexes and row counts.
        </p>
        <Segmented
          layoutId="docs-format"
          value={format}
          onChange={setFormat}
          options={[
            { value: 'html', label: 'HTML page' },
            { value: 'md', label: 'Markdown + ER diagram' },
          ]}
        />
        <p className="text-xs text-faint">
          {format === 'html'
            ? 'A single self-contained file with a table of contents; works offline, prints cleanly and follows light/dark mode.'
            : 'Includes a Mermaid erDiagram that GitHub, GitLab and many editors render as a diagram.'}
        </p>
      </div>
    </Modal>
  );
}

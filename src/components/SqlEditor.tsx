import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { MSSQL, MySQL, PostgreSQL, SQLite, sql, type SQLDialect } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import { forwardRef, useMemo } from 'react';
import type { DbKind, SchemaSnapshot } from '../../shared/types';

const DIALECT: Record<DbKind, SQLDialect> = { sqlite: SQLite, postgres: PostgreSQL, mysql: MySQL, mssql: MSSQL };

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: 'var(--fg)' },
    '.cm-content': { caretColor: '#a5b4fc', padding: '10px 0' },
    '.cm-cursor': { borderLeftColor: '#a5b4fc', borderLeftWidth: '2px' },
    '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--faint)', border: 'none', paddingLeft: '6px' },
    '.cm-activeLine': { backgroundColor: 'rgb(129 140 248 / 0.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#a5b4fc' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgb(129 140 248 / 0.28) !important',
    },
    '.cm-matchingBracket': { backgroundColor: 'rgb(34 211 238 / 0.18)', outline: 'none' },
    '.cm-tooltip': {
      backgroundColor: 'rgb(14 17 33 / 0.96)',
      border: '1px solid rgb(129 140 248 / 0.25)',
      backdropFilter: 'blur(16px)',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'rgb(129 140 248 / 0.25)', color: 'var(--fg)' },
    '.cm-completionIcon': { opacity: 0.6 },
    '.cm-placeholder': { color: 'var(--faint)' },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: '#a78bfa', fontWeight: '500' },
  { tag: [t.string, t.special(t.string)], color: '#6ee7b7' },
  { tag: [t.number, t.bool, t.null], color: '#fbbf24' },
  { tag: t.comment, color: '#5d6389', fontStyle: 'italic' },
  { tag: [t.typeName, t.standard(t.name)], color: '#22d3ee' },
  { tag: [t.operator, t.punctuation], color: '#959bbb' },
  { tag: t.special(t.name), color: '#f9a8d4' },
  { tag: t.name, color: '#e8eaf6' },
]);

interface Props {
  value: string;
  onChange?: (v: string) => void;
  kind: DbKind;
  schema?: SchemaSnapshot;
  onRun?: () => void;
  readOnly?: boolean;
  placeholder?: string;
  minimal?: boolean;
}

export const SqlEditor = forwardRef<ReactCodeMirrorRef, Props>(function SqlEditor(
  { value, onChange, kind, schema, onRun, readOnly, placeholder, minimal },
  ref,
) {
  const extensions = useMemo(() => {
    const completionSchema: Record<string, string[]> = {};
    for (const tbl of schema?.tables ?? []) {
      const cols = tbl.columns.map((c) => c.name);
      completionSchema[tbl.name] = cols;
      if (tbl.schema) completionSchema[`${tbl.schema}.${tbl.name}`] = cols;
    }
    const exts = [
      sql({ dialect: DIALECT[kind], schema: completionSchema, upperCaseKeywords: true }),
      theme,
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
    ];
    if (onRun) {
      exts.push(
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                onRun();
                return true;
              },
            },
          ]),
        ),
      );
    }
    return exts;
  }, [kind, schema, onRun]);

  return (
    <CodeMirror
      ref={ref}
      value={value}
      onChange={onChange}
      extensions={extensions}
      readOnly={readOnly}
      editable={!readOnly}
      placeholder={placeholder}
      theme="none"
      height="100%"
      className="h-full"
      basicSetup={{
        lineNumbers: !minimal,
        foldGutter: !minimal,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
        autocompletion: !readOnly,
      }}
    />
  );
});

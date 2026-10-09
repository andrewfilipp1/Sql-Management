import { createContext, useContext } from 'react';

/** Actions the table nodes call while the diagram is in edit mode (columns are addressed by current name). */
export interface DesignActions {
  editing: boolean;
  /** Id of a <datalist> with this engine's common types. */
  typesListId: string;
  renameTable(key: string, name: string): void;
  dropTable(key: string): void;
  restoreTable(key: string): void;
  addColumn(key: string): void;
  renameColumn(key: string, column: string, name: string): void;
  setType(key: string, column: string, type: string): void;
  toggleNullable(key: string, column: string): void;
  togglePk(key: string, column: string): void;
  dropColumn(key: string, column: string): void;
  restoreColumn(key: string, column: string): void;
  /** Newly added column that should open in rename mode. */
  autoEdit?: { key: string; column: string } | null;
}

const noop = () => {};
export const DesignContext = createContext<DesignActions>({
  editing: false,
  typesListId: '',
  renameTable: noop,
  dropTable: noop,
  restoreTable: noop,
  addColumn: noop,
  renameColumn: noop,
  setType: noop,
  toggleNullable: noop,
  togglePk: noop,
  dropColumn: noop,
  restoreColumn: noop,
});

export const useDesign = () => useContext(DesignContext);

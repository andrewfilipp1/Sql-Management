import type { ColumnInfo, TableInfo } from '../../shared/types';

export type GeneratorId =
  | 'skip'
  | 'fk'
  | 'existing'
  | 'sequence'
  | 'first_name'
  | 'last_name'
  | 'full_name'
  | 'email'
  | 'phone'
  | 'city'
  | 'country'
  | 'street'
  | 'postal_code'
  | 'company'
  | 'url'
  | 'title'
  | 'paragraph'
  | 'word'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'uuid'
  | 'json'
  | 'null';

export const GENERATORS: { id: GeneratorId; label: string }[] = [
  { id: 'skip', label: 'Skip (default / auto)' },
  { id: 'fk', label: 'Existing parent key' },
  { id: 'existing', label: 'Values already in the column' },
  { id: 'sequence', label: 'Next number' },
  { id: 'first_name', label: 'First name' },
  { id: 'last_name', label: 'Last name' },
  { id: 'full_name', label: 'Full name' },
  { id: 'email', label: 'Email' },
  { id: 'phone', label: 'Phone' },
  { id: 'city', label: 'City' },
  { id: 'country', label: 'Country' },
  { id: 'street', label: 'Street address' },
  { id: 'postal_code', label: 'Postal code' },
  { id: 'company', label: 'Company' },
  { id: 'url', label: 'URL' },
  { id: 'title', label: 'Title / short text' },
  { id: 'paragraph', label: 'Paragraph' },
  { id: 'word', label: 'Word' },
  { id: 'integer', label: 'Integer' },
  { id: 'decimal', label: 'Decimal' },
  { id: 'boolean', label: 'Boolean' },
  { id: 'date', label: 'Date' },
  { id: 'datetime', label: 'Date & time' },
  { id: 'uuid', label: 'UUID' },
  { id: 'json', label: 'JSON object' },
  { id: 'null', label: 'NULL' },
];

const FIRST = ['Maria', 'Giorgos', 'Eleni', 'Nikos', 'Katerina', 'Dimitris', 'Sofia', 'Kostas', 'Anna', 'Yannis', 'Emma', 'Lucas', 'Mia', 'Noah', 'Lea', 'Marco', 'Ines', 'Jonas'];
const LAST = ['Papadopoulou', 'Georgiou', 'Nikolaidis', 'Ioannou', 'Vlachou', 'Karras', 'Muller', 'Rossi', 'Garcia', 'Martin', 'Silva', 'Novak', 'Jensen', 'Smith'];
const CITIES = ['Athens', 'Thessaloniki', 'Patras', 'Heraklion', 'Berlin', 'Milan', 'Lyon', 'Lisbon', 'Vienna', 'Prague', 'Madrid', 'Dublin'];
const COUNTRIES = ['Greece', 'Cyprus', 'Germany', 'Italy', 'France', 'Portugal', 'Austria', 'Spain', 'Ireland', 'Netherlands'];
const STREETS = ['Ermou', 'Egnatia', 'Main Street', 'Via Roma', 'Rue de la Paix', 'Hauptstrasse', 'Gran Via', 'Kings Road'];
const COMPANIES = ['Acme', 'Northwind', 'Contoso', 'Globex', 'Initech', 'Hellas Tech', 'Blue Harbor', 'Orbit Labs'];
const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim minim veniam quis nostrud'.split(' ');

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const int = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pad = (n: number) => String(n).padStart(2, '0');
const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ');

/** Max length from types such as varchar(40) / nvarchar(40); undefined for unbounded. */
function maxLen(type: string): number | undefined {
  const m = /char\s*\((\d+)\)/i.exec(type);
  return m ? Number(m[1]) : undefined;
}

export interface ColumnPlan {
  column: ColumnInfo;
  gen: GeneratorId;
  /** Candidate values (FK parents or existing distinct values). */
  values?: unknown[];
  /** Start for 'sequence'. */
  start?: number;
  /** Observed (or conventional) value range for numbers, so CHECK constraints usually hold. */
  range?: [number, number];
  unique?: boolean;
  /** Probability of NULL for nullable columns. */
  nullRate: number;
}

/** Picks a sensible generator from the column name and type. */
export function guessGenerator(c: ColumnInfo, table: TableInfo): GeneratorId {
  const n = c.name.toLowerCase();
  const t = c.type.toLowerCase();
  if (c.isIdentity) return 'skip';
  if (table.foreignKeys.some((f) => f.columns.includes(c.name))) return 'fk';
  if (c.isPrimaryKey && /int|numeric|decimal/.test(t)) return 'sequence';
  if (c.isPrimaryKey && /uuid|uniqueidentifier/.test(t)) return 'uuid';
  if (/uuid|uniqueidentifier|guid/.test(t)) return 'uuid';
  if (/^(bool|boolean|bit)$|tinyint\(1\)/.test(t) || /^(is|has)_|active|enabled/.test(n)) return 'boolean';
  if (/email/.test(n)) return 'email';
  if (/first_?name|given/.test(n)) return 'first_name';
  if (/last_?name|surname|family/.test(n)) return 'last_name';
  if (/full_?name|^name$|customer|contact/.test(n) && /char|text/.test(t)) return 'full_name';
  if (/phone|mobile|tel/.test(n)) return 'phone';
  if (/city|town/.test(n)) return 'city';
  if (/country/.test(n)) return /char\s*\(\s*2\s*\)|code/.test(t + n) ? 'existing' : 'country';
  if (/street|address/.test(n)) return 'street';
  if (/zip|postal/.test(n)) return 'postal_code';
  if (/company|supplier|vendor|brand/.test(n)) return 'company';
  if (/url|website|link/.test(n)) return 'url';
  if (/status|type|kind|category|method|state|level|role/.test(n) && /char|text|enum/.test(t)) return 'existing';
  if (/title|subject|name|label|sku|code/.test(n)) return 'title';
  if (/desc|body|comment|note|text|content|payload/.test(n)) return 'paragraph';
  if (/json/.test(t)) return 'json';
  if (/timestamp|datetime/.test(t) || /_at$|time/.test(n)) return 'datetime';
  if (/date/.test(t) || /date|_on$|birth/.test(n)) return 'date';
  if (/decimal|numeric|money|real|float|double/.test(t) || /price|amount|total|cost/.test(n)) return 'decimal';
  if (/int/.test(t)) return 'integer';
  return 'word';
}

export function generateValue(p: ColumnPlan, i: number): unknown {
  if (p.gen === 'skip') return undefined;
  if (p.column.nullable && p.nullRate > 0 && p.gen !== 'fk' && Math.random() < p.nullRate) return null;
  const len = maxLen(p.column.type);
  const fit = (s: string) => (len ? s.slice(0, len) : s);
  const u = (s: string) => (p.unique ? `${s}${i + 1}` : s);
  switch (p.gen) {
    case 'fk':
    case 'existing':
      return p.values?.length ? pick(p.values) : null;
    case 'sequence':
      return (p.start ?? 1) + i;
    case 'first_name':
      return fit(u(pick(FIRST)));
    case 'last_name':
      return fit(u(pick(LAST)));
    case 'full_name':
      return fit(u(`${pick(FIRST)} ${pick(LAST)}`));
    case 'email': {
      // Unique by construction: index suffix plus a random tag.
      return fit(`${pick(FIRST)}.${pick(LAST)}.${i + 1}${Math.random().toString(36).slice(2, 6)}@example.com`.toLowerCase());
    }
    case 'phone':
      return fit(`+30 69${int(10000000, 99999999)}`);
    case 'city':
      return fit(pick(CITIES));
    case 'country':
      return fit(pick(COUNTRIES));
    case 'street':
      return fit(`${pick(STREETS)} ${int(1, 250)}`);
    case 'postal_code':
      return fit(String(int(10000, 99999)));
    case 'company':
      return fit(u(`${pick(COMPANIES)} ${pick(['Ltd', 'GmbH', 'SA', 'Inc', 'Group'])}`));
    case 'url':
      return fit(`https://example.com/${pick(WORDS)}/${i + 1}`);
    case 'title': {
      const s = words(int(2, 4));
      return fit(u(s.charAt(0).toUpperCase() + s.slice(1)));
    }
    case 'paragraph': {
      const s = words(int(8, 24));
      return fit(s.charAt(0).toUpperCase() + s.slice(1) + '.');
    }
    case 'word':
      return fit(u(pick(WORDS)));
    case 'integer':
      if (p.unique) return (p.start ?? 1) + i;
      return p.range ? int(Math.ceil(p.range[0]), Math.floor(p.range[1])) : int(1, 1000);
    case 'decimal':
      if (p.range) return Math.round((p.range[0] + Math.random() * (p.range[1] - p.range[0])) * 100) / 100;
      return Math.round(Math.random() * 100_000) / 100;
    case 'boolean':
      return Math.random() < 0.5;
    case 'date': {
      const d = new Date(Date.now() - int(0, 730) * 86_400_000);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    case 'datetime': {
      const d = new Date(Date.now() - int(0, 730 * 86_400) * 1000);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    case 'uuid':
      return crypto.randomUUID();
    case 'json':
      return JSON.stringify({ seed: i + 1, tag: pick(WORDS) });
    case 'null':
      return null;
  }
}

/** Conventional ranges for well-known numeric column names when the table has no rows yet. */
export function conventionalRange(name: string): [number, number] | undefined {
  const n = name.toLowerCase();
  if (/rating|stars|score/.test(n)) return [1, 5];
  if (/percent|pct/.test(n)) return [0, 100];
  if (/qty|quantity/.test(n)) return [1, 10];
  if (/age/.test(n)) return [18, 90];
  return undefined;
}

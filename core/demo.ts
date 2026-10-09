import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, listConnections, upsertConnection } from './store.ts';

const SCHEMA = `
CREATE TABLE countries (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  street TEXT NOT NULL,
  city TEXT NOT NULL,
  postal_code TEXT,
  country_code TEXT NOT NULL REFERENCES countries(code)
);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id)
);
CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country_code TEXT REFERENCES countries(code)
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price NUMERIC NOT NULL,
  supplier_id INTEGER REFERENCES suppliers(id),
  active BOOLEAN NOT NULL DEFAULT 1
);
CREATE TABLE product_categories (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, category_id)
);
CREATE TABLE warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT NOT NULL
);
CREATE TABLE inventory (
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (warehouse_id, product_id)
);
CREATE TABLE employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  title TEXT,
  manager_id INTEGER REFERENCES employees(id),
  warehouse_id INTEGER REFERENCES warehouses(id)
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  shipping_address_id INTEGER REFERENCES addresses(id),
  handled_by INTEGER REFERENCES employees(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),
  ordered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE order_items (
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC NOT NULL,
  PRIMARY KEY (order_id, line_no)
);
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  amount NUMERIC NOT NULL,
  method TEXT NOT NULL,
  paid_at DATETIME
);
CREATE TABLE shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  carrier TEXT,
  tracking_no TEXT,
  shipped_at DATETIME
);
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  payload TEXT,
  at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_orders_customer ON orders(customer_id);
CREATE INDEX ix_orders_status ON orders(status, ordered_at);
CREATE INDEX ix_reviews_product ON reviews(product_id);
CREATE VIEW v_order_totals AS
  SELECT o.id AS order_id, c.first_name || ' ' || c.last_name AS customer, o.status,
         SUM(oi.quantity * oi.unit_price) AS total
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  JOIN order_items oi ON oi.order_id = o.id
  GROUP BY o.id;
CREATE TRIGGER trg_orders_audit AFTER UPDATE OF status ON orders
BEGIN
  INSERT INTO audit_log(event, payload) VALUES ('order_status', NEW.id || ':' || NEW.status);
END;
`;

const FIRST = ['Maria', 'Giorgos', 'Eleni', 'Nikos', 'Katerina', 'Dimitris', 'Sofia', 'Kostas', 'Anna', 'Yannis', 'Elena', 'Petros'];
const LAST = ['Papadopoulou', 'Georgiou', 'Nikolaidis', 'Ioannou', 'Vlachou', 'Karras', 'Pappas', 'Antoniou', 'Christou', 'Dimas'];
const CITIES = ['Athens', 'Thessaloniki', 'Patras', 'Heraklion', 'Larissa', 'Volos'];
const PRODUCTS = [
  'Mechanical Keyboard', 'Wireless Mouse', '27" Monitor', 'USB-C Hub', 'Laptop Stand', 'Noise-Cancelling Headphones',
  'Webcam HD', 'Desk Lamp', 'Ergonomic Chair', 'External SSD 1TB', 'Bluetooth Speaker', 'Smartwatch', 'Phone Case',
  'Charging Pad', 'Graphics Tablet', 'Microphone', 'Router AX3000', 'Portable Charger', 'HDMI Cable', 'Office Desk',
];

export function ensureDemoDatabase() {
  const file = path.join(getDataDir(), 'demo.sqlite');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(getDataDir(), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    let seed = 42;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

    db.exec('BEGIN');
    const ins = (sql: string, ...v: (string | number | null)[]) => db.prepare(sql).run(...v);
    for (const [c, n] of [['GR', 'Greece'], ['CY', 'Cyprus'], ['DE', 'Germany'], ['IT', 'Italy'], ['FR', 'France'], ['US', 'United States']])
      ins('INSERT INTO countries VALUES (?, ?)', c, n);
    for (let i = 1; i <= 60; i++) {
      const f = pick(FIRST);
      const l = pick(LAST);
      ins('INSERT INTO customers (first_name, last_name, email, created_at) VALUES (?,?,?,?)', f, l,
        `${f}.${l}${i}@example.com`.toLowerCase(), `2025-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')} 10:00:00`);
      ins('INSERT INTO addresses (customer_id, street, city, postal_code, country_code) VALUES (?,?,?,?,?)', i,
        `${pick(['Ermou', 'Egnatia', 'Tsimiski', 'Panepistimiou', 'Stadiou'])} ${int(1, 200)}`, pick(CITIES), String(int(10000, 85000)), rnd() < 0.85 ? 'GR' : 'CY');
    }
    const cats = [['Electronics', null], ['Computers', 1], ['Accessories', 2], ['Audio', 1], ['Furniture', null], ['Office', 5], ['Mobile', 1]] as const;
    for (const [n, p] of cats) ins('INSERT INTO categories (name, parent_id) VALUES (?, ?)', n, p);
    for (const [n, c] of [['Hellas Tech', 'GR'], ['Berlin Components', 'DE'], ['Milano Design', 'IT'], ['Pacific Imports', 'US']])
      ins('INSERT INTO suppliers (name, country_code) VALUES (?, ?)', n, c);
    PRODUCTS.forEach((p, i) => {
      ins('INSERT INTO products (sku, name, price, supplier_id, active) VALUES (?,?,?,?,?)', `SKU-${1000 + i}`, p, int(9, 480) + 0.99, int(1, 4), rnd() < 0.9 ? 1 : 0);
      ins('INSERT INTO product_categories VALUES (?, ?)', i + 1, int(2, 7));
    });
    for (const [n, c] of [['Central', 'Athens'], ['North Hub', 'Thessaloniki'], ['Islands', 'Heraklion']]) ins('INSERT INTO warehouses (name, city) VALUES (?, ?)', n, c);
    for (let w = 1; w <= 3; w++) for (let p = 1; p <= PRODUCTS.length; p++) ins('INSERT INTO inventory VALUES (?,?,?)', w, p, int(0, 250));
    ins('INSERT INTO employees (full_name, title, manager_id, warehouse_id) VALUES (?,?,?,?)', 'Alexandra Mavri', 'Operations Director', null, 1);
    for (let i = 0; i < 8; i++) ins('INSERT INTO employees (full_name, title, manager_id, warehouse_id) VALUES (?,?,?,?)', `${pick(FIRST)} ${pick(LAST)}`, pick(['Order Clerk', 'Shipping Lead', 'Support Agent']), 1, int(1, 3));
    const statuses = ['pending', 'paid', 'shipped', 'delivered', 'delivered', 'delivered', 'cancelled'];
    for (let o = 1; o <= 240; o++) {
      const cust = int(1, 60);
      const status = pick(statuses);
      ins('INSERT INTO orders (customer_id, shipping_address_id, handled_by, status, ordered_at) VALUES (?,?,?,?,?)', cust, cust, int(2, 9), status,
        `2026-${String(int(1, 9)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')} ${String(int(8, 22)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}:00`);
      let total = 0;
      const lines = int(1, 4);
      for (let l = 1; l <= lines; l++) {
        const price = int(9, 480) + 0.99;
        const qty = int(1, 3);
        total += price * qty;
        ins('INSERT INTO order_items VALUES (?,?,?,?,?)', o, l, int(1, PRODUCTS.length), qty, price);
      }
      if (status !== 'pending' && status !== 'cancelled') {
        ins('INSERT INTO payments (order_id, amount, method, paid_at) VALUES (?,?,?,?)', o, Math.round(total * 100) / 100, pick(['card', 'paypal', 'bank_transfer']), '2026-09-01 12:00:00');
      }
      if (status === 'shipped' || status === 'delivered') {
        ins('INSERT INTO shipments (order_id, warehouse_id, carrier, tracking_no, shipped_at) VALUES (?,?,?,?,?)', o, int(1, 3), pick(['ACS', 'ELTA', 'DHL']), `TRK${100000 + o}`, '2026-09-02 09:00:00');
      }
    }
    for (let r = 0; r < 90; r++) {
      ins('INSERT INTO reviews (product_id, customer_id, rating, body) VALUES (?,?,?,?)', int(1, PRODUCTS.length), int(1, 60), int(2, 5),
        pick(['Great value!', 'Works as expected.', 'Fast delivery, happy.', 'Could be better.', 'Excellent quality.']));
    }
    db.exec('COMMIT');
    db.close();
  }
  if (!listConnections().length) {
    upsertConnection({ name: 'Demo shop (SQLite)', kind: 'sqlite', file, color: '#6366f1' });
  }
}

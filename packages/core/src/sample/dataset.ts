/**
 * A deterministic, generated sample dataset: a small online shop with
 * customers, products, orders and order lines. Every value comes from a seeded
 * PRNG, so the same seed always yields the same database. The data is
 * synthetic: names are combinations of common Vietnamese name parts and real
 * city names, nothing describes real people or sales.
 */

export interface SampleOptions {
  /** Multiplies the number of customers and orders (default 1). */
  readonly scale?: number;
  readonly seed?: number;
}

export interface SampleSizes {
  readonly customers: number;
  readonly products: number;
  readonly orders: number;
}

/** Small, fast pseudo-random generator (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAMILY = [
  'Nguyễn',
  'Trần',
  'Lê',
  'Phạm',
  'Hoàng',
  'Huỳnh',
  'Phan',
  'Vũ',
  'Võ',
  'Đặng',
  'Bùi',
  'Đỗ',
  'Hồ',
  'Ngô',
  'Dương',
  'Lý',
];
const MIDDLE = ['Văn', 'Thị', 'Minh', 'Ngọc', 'Thanh', 'Quốc', 'Hữu', 'Gia', 'Đức', 'Thu'];
const GIVEN = [
  'An',
  'Bình',
  'Châu',
  'Dũng',
  'Giang',
  'Hà',
  'Hải',
  'Hạnh',
  'Hiếu',
  'Hoa',
  'Hùng',
  'Hương',
  'Khánh',
  'Lan',
  'Linh',
  'Long',
  'Mai',
  'Nam',
  'Ngân',
  'Nhung',
  'Phong',
  'Phúc',
  'Quân',
  'Quỳnh',
  'Sơn',
  'Tâm',
  'Thảo',
  'Trang',
  'Trí',
  'Trung',
  'Tuấn',
  'Vy',
  'Yến',
];
/** Cities with weights, so city-level aggregates look skewed like real data. */
const CITIES: readonly [string, number][] = [
  ['Hồ Chí Minh', 30],
  ['Hà Nội', 25],
  ['Đà Nẵng', 9],
  ['Hải Phòng', 8],
  ['Cần Thơ', 6],
  ['Huế', 5],
  ['Nha Trang', 5],
  ['Đà Lạt', 4],
  ['Vũng Tàu', 4],
  ['Quy Nhơn', 4],
];
const CATALOG: Record<string, { items: string[]; price: [number, number] }> = {
  Coffee: {
    items: [
      'Robusta beans',
      'Arabica Cầu Đất',
      'Phin filter',
      'Cold brew kit',
      'Weasel blend',
      'Coffee grinder',
    ],
    price: [4, 60],
  },
  Tea: {
    items: ['Thái Nguyên green tea', 'Lotus tea', 'Oolong', 'Jasmine tea', 'Artichoke tea'],
    price: [3, 40],
  },
  Books: {
    items: ['Novel', 'Cookbook', 'Travel guide', 'Poetry collection', 'Atlas', 'Dictionary'],
    price: [5, 45],
  },
  Stationery: {
    items: ['Notebook', 'Fountain pen', 'Pencil set', 'Sketchbook', 'Planner'],
    price: [1, 25],
  },
  Home: {
    items: ['Rice cooker', 'Bamboo tray', 'Ceramic bowl', 'Rattan lamp', 'Lacquer box'],
    price: [6, 120],
  },
  Electronics: {
    items: ['Headphones', 'Power bank', 'Keyboard', 'Webcam', 'Speaker'],
    price: [12, 180],
  },
  Clothing: {
    items: ['Áo dài', 'Linen shirt', 'Conical hat', 'Silk scarf', 'Sandals'],
    price: [8, 90],
  },
};
const VARIANTS = ['', ' (small)', ' (large)', ' deluxe', ' classic', ' gift box'];
const STATUSES: readonly [string, number][] = [
  ['delivered', 78],
  ['shipped', 10],
  ['pending', 6],
  ['cancelled', 6],
];

function weighted<T>(rand: () => number, options: readonly [T, number][]): T {
  const total = options.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [value, w] of options) {
    r -= w;
    if (r < 0) return value;
  }
  return options.at(-1)![0];
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function sql(v: string | number | boolean): string {
  if (typeof v === 'string') return `'${v.replaceAll("'", "''")}'`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

export const SAMPLE_SCHEMA = [
  `CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  joined INTEGER NOT NULL,
  vip BOOLEAN NOT NULL
)`,
  `CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price REAL NOT NULL
)`,
  `CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  ordered_on TEXT NOT NULL,
  status TEXT NOT NULL
)`,
  `CREATE TABLE order_items (
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  PRIMARY KEY (order_id, product_id)
)`,
  'CREATE INDEX orders_customer ON orders (customer_id)',
  'CREATE INDEX customers_city ON customers (city)',
];

export function sampleSizes(options: SampleOptions = {}): SampleSizes {
  const scale = options.scale ?? 1;
  return {
    customers: Math.max(1, Math.round(1000 * scale)),
    products: 120,
    orders: Math.max(1, Math.round(5000 * scale)),
  };
}

/** SQL statements that create and fill the sample database. */
export function sampleDatasetSql(options: SampleOptions = {}): string[] {
  const rand = prng(options.seed ?? 2026);
  const sizes = sampleSizes(options);
  const statements = [...SAMPLE_SCHEMA];
  const batch = (table: string, rows: string[]) => {
    for (let i = 0; i < rows.length; i += 500) {
      statements.push(`INSERT INTO ${table} VALUES\n${rows.slice(i, i + 500).join(',\n')}`);
    }
  };

  const customers: string[] = [];
  for (let id = 1; id <= sizes.customers; id++) {
    const name = `${pick(rand, FAMILY)} ${pick(rand, MIDDLE)} ${pick(rand, GIVEN)}`;
    const city = weighted(rand, CITIES);
    const joined = 2018 + Math.floor(rand() * 8);
    customers.push(`(${id}, ${sql(name)}, ${sql(city)}, ${joined}, ${sql(rand() < 0.08)})`);
  }
  batch('customers', customers);

  const products: { price: number }[] = [];
  const productRows: string[] = [];
  const categories = Object.keys(CATALOG);
  for (let id = 1; id <= sizes.products; id++) {
    const category = categories[(id - 1) % categories.length]!;
    const { items, price } = CATALOG[category]!;
    const name = `${pick(rand, items)}${pick(rand, VARIANTS)}`;
    const p = Math.round((price[0] + (price[1] - price[0]) * rand() ** 2) * 100) / 100;
    products.push({ price: p });
    productRows.push(`(${id}, ${sql(name)}, ${sql(category)}, ${p.toFixed(2)})`);
  }
  batch('products', productRows);

  const orders: string[] = [];
  const items: string[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let id = 1; id <= sizes.orders; id++) {
    // A few customers order a lot: square the random number to skew towards low ids.
    const customer = 1 + Math.floor(rand() ** 2 * sizes.customers);
    const day = new Date(start + Math.floor(rand() * 730) * 86_400_000).toISOString().slice(0, 10);
    orders.push(`(${id}, ${customer}, ${sql(day)}, ${sql(weighted(rand, STATUSES))})`);
    const lines = 1 + Math.floor(rand() * 4);
    const chosen = new Set<number>();
    while (chosen.size < lines) chosen.add(1 + Math.floor(rand() * sizes.products));
    for (const product of chosen) {
      const quantity = 1 + Math.floor(rand() ** 3 * 5);
      const discount = rand() < 0.15 ? 0.9 : 1;
      const unit = Math.round(products[product - 1]!.price * discount * 100) / 100;
      items.push(`(${id}, ${product}, ${quantity}, ${unit.toFixed(2)})`);
    }
  }
  batch('orders', orders);
  batch('order_items', items);
  statements.push('ANALYZE');
  return statements;
}

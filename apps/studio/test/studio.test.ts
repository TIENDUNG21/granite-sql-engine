import { Database, type PlanNodeInfo } from '@granite/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../src/examples.ts';
import { escapeHtml, highlightSql } from '../src/highlight.ts';
import { layoutPlan, type PlacedNode } from '../src/plan-layout.ts';
import { planToSvg } from '../src/plan-svg.ts';

/** Text content of highlighted HTML, as the browser would show it. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

describe('highlightSql', () => {
  it('wraps tokens by class', () => {
    expect(highlightSql("SELECT upper(name), 1.5 FROM t WHERE x = 'a<b' -- note")).toBe(
      '<span class="t-kw">SELECT</span> <span class="t-fn">upper</span>(name), ' +
        '<span class="t-num">1.5</span> <span class="t-kw">FROM</span> t ' +
        '<span class="t-kw">WHERE</span> x = <span class="t-str">&#39;a&lt;b&#39;</span> ' +
        '<span class="t-cmt">-- note</span>',
    );
    expect(highlightSql('CAST($1 AS integer)')).toContain('<span class="t-type">integer</span>');
    expect(highlightSql('CAST($1 AS integer)')).toContain('<span class="t-param">$1</span>');
  });

  it('marks broken input instead of throwing', () => {
    expect(highlightSql("SELECT 'open")).toContain('<span class="t-err">&#39;open</span>');
    expect(highlightSql('SELECT @')).toContain('<span class="t-err">@</span>');
  });

  it('keeps the text exactly, whatever is typed', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (sql) => {
        expect(textOf(highlightSql(sql))).toBe(sql);
      }),
      { numRuns: 500 },
    );
  });

  it('escapes every markup character', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

const leaf = (op: string): PlanNodeInfo => ({ op, detail: '', rows: 1, cost: 1, children: [] });
const node = (op: string, ...children: PlanNodeInfo[]): PlanNodeInfo => ({
  op,
  detail: '',
  rows: 1,
  cost: 1,
  children,
});
const size = { width: 100, height: 40, gapX: 10, gapY: 20 };

const arbitraryPlan: fc.Arbitrary<PlanNodeInfo> = fc.letrec<{ plan: PlanNodeInfo }>((tie) => ({
  plan: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constant(leaf('Scan')),
    fc.array(tie('plan'), { minLength: 1, maxLength: 3 }).map((kids) => node('Op', ...kids)),
  ),
})).plan;

describe('layoutPlan', () => {
  it('centres parents over their children', () => {
    const layout = layoutPlan(node('Join', leaf('A'), node('Filter', leaf('B'))), size);
    const [join, a, filter, b] = layout.nodes as [PlacedNode, PlacedNode, PlacedNode, PlacedNode];
    expect([a.x, b.x, filter.x]).toEqual([0, 110, 110]);
    expect(join.x).toBe(55);
    expect([join.y, a.y, filter.y, b.y]).toEqual([0, 60, 60, 120]);
    expect(layout).toMatchObject({ width: 210, height: 160 });
  });

  it('never overlaps boxes and keeps them inside the canvas', () => {
    fc.assert(
      fc.property(arbitraryPlan, (plan) => {
        const { nodes, width, height } = layoutPlan(plan, size);
        for (const n of nodes) {
          expect(n.x).toBeGreaterThanOrEqual(0);
          expect(n.x + size.width).toBeLessThanOrEqual(width);
          expect(n.y + size.height).toBeLessThanOrEqual(height);
          if (n.parent) expect(n.y).toBe(n.parent.y + size.height + size.gapY);
        }
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const [p, q] = [nodes[i]!, nodes[j]!];
            if (p.y === q.y)
              expect(Math.abs(p.x - q.x)).toBeGreaterThanOrEqual(size.width + size.gapX);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('planToSvg', () => {
  it('draws the plan of a real query, with measurements after ANALYZE', () => {
    const db = Database.open();
    db.execute(
      'CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE b (a_id INTEGER, w INTEGER)',
    );
    db.execute(
      "INSERT INTO a VALUES (1, '<x>'), (2, 'y'); INSERT INTO b VALUES (1, 10), (1, 20), (2, 5)",
    );
    const estimated = planToSvg(
      db.query(
        "EXPLAIN SELECT v, sum(w) FROM a JOIN b ON b.a_id = a.id WHERE v <> '<x>' GROUP BY v",
      ).plan!,
    );
    expect(estimated).toMatch(/^<svg [^>]*role="img"/);
    expect(estimated).toContain('>HashJoin<');
    expect(estimated).toContain('&lt;x&gt;');
    expect(estimated).not.toContain('<x>');
    expect(estimated).not.toContain('actual');
    const analyzed = planToSvg(
      db.query('EXPLAIN ANALYZE SELECT * FROM a JOIN b ON b.a_id = a.id').plan!,
    );
    expect(analyzed).toMatch(/actual 3 rows/);
    expect(analyzed).toContain('class="bar"');
  });

  it('truncates long details and keeps the full text in the tooltip', () => {
    const detail = 'filter: ' + 'x = 1 AND '.repeat(20) + 'y = 2';
    const svg = planToSvg({ op: 'SeqScan', detail, rows: 5, cost: 2.5, children: [] });
    expect(svg).toContain('…</text>');
    expect(svg).toContain(`<title>SeqScan ${detail}</title>`);
    expect(svg).toContain('est 5 rows · cost 2.5');
  });
});

describe('examples', () => {
  it('all run on the sample database, except the one that shows an error', async () => {
    const { sampleDatasetSql } = await import('@granite/core');
    const db = Database.open();
    for (const sql of sampleDatasetSql({ scale: 0.2 })) db.execute(sql);
    for (const example of EXAMPLES) {
      const s = db.session();
      if (example.title === 'Error messages') {
        expect(() => s.execute(example.sql)).toThrow('column "cty" does not exist');
      } else {
        expect(s.execute(example.sql).at(-1)!.columns.length).toBeGreaterThan(0);
      }
      s.close();
    }
  });
});

import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { findLeaks, triageRecordSchema, type TriageRecord } from './schema.js';

function loadJsonFiles(folder: string): { file: string; data: unknown }[] {
  const dir = new URL(`./${folder}/`, import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      file: `${folder}/${name}`,
      data: JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as unknown,
    }));
}

const records = loadJsonFiles('records');
const fixtures = loadJsonFiles('fixtures');

function parsed(data: unknown): TriageRecord {
  return triageRecordSchema.parse(data);
}

describe('committed triage files', () => {
  it.each([...records, ...fixtures])('$file matches the schema', ({ data }) => {
    expect(triageRecordSchema.safeParse(data).error?.issues).toBeUndefined();
  });

  it.each(records)('$file is a real labeled failure, not synthetic', ({ data }) => {
    expect(parsed(data).synthetic).toBe(false);
  });

  it.each(fixtures)('$file is marked synthetic', ({ data }) => {
    expect(parsed(data).synthetic).toBe(true);
  });

  it.each([...records, ...fixtures])('$file passes the leak guard', ({ data }) => {
    expect(findLeaks(data)).toEqual([]);
  });

  it('uses each id once, and the file name matches the id', () => {
    const all = [...records, ...fixtures];
    const ids = all.map(({ data }) => parsed(data).id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { file, data } of all) expect(file.endsWith(`/${parsed(data).id}.json`)).toBe(true);
  });
});

describe('triage record rules', () => {
  const base = fixtures.find(({ file }) => file.endsWith('tri-9001.json'))?.data as TriageRecord;
  const disagreeing = fixtures.find(({ file }) => file.endsWith('tri-9002.json'))
    ?.data as TriageRecord;

  function issues(record: unknown): string[] {
    return (triageRecordSchema.safeParse(record).error?.issues ?? []).map((issue) => issue.message);
  }

  it('rejects two labels from the same labeler', () => {
    const [first, second] = base.labels;
    const record = { ...base, labels: [first, { ...second, labeler: first?.labeler }] };
    expect(issues(record)).toContain('the two labels need different labelers');
  });

  it('rejects a finalClass that contradicts agreeing labels', () => {
    expect(issues({ ...base, finalClass: 'product-bug' })).toContain(
      'labels agree, so finalClass must match them',
    );
  });

  it('requires an adjudication when labels disagree', () => {
    const { adjudication: _dropped, ...withoutAdjudication } = disagreeing;
    expect(issues(withoutAdjudication)).toContain(
      'labels disagree, so an adjudication is required',
    );
  });

  it('requires the adjudicator to be a third person', () => {
    const record = {
      ...disagreeing,
      adjudication: { ...disagreeing.adjudication, by: disagreeing.labels[0]?.labeler },
    };
    expect(issues(record)).toContain('the adjudicator must be a third person');
  });

  it('rejects real names, full dates and raw run ids', () => {
    const record = {
      ...base,
      labels: [{ ...base.labels[0], labeler: 'Priya' }, base.labels[1]],
      source: { ...base.source, failedOn: '2026-09-14', runRef: '18234567890' },
    };
    expect(issues(record).length).toBeGreaterThanOrEqual(3);
  });
});

describe('leak guard', () => {
  it.each([
    ['an email address', 'contact qa.lead@corp-internal.com for access'],
    ['a GitHub token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    [
      'a JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ],
    ['credentials in a URL', 'git clone https://bot:s3cret@git.corp.local/app.git'],
    ['a real host', 'GET https://checkout.realshop.com/api/cart failed'],
    ['a private IP', 'connect ECONNREFUSED 10.20.30.40:5432'],
  ])('flags %s', (_name, text) => {
    expect(findLeaks({ evidence: { logExcerpt: text } }).length).toBeGreaterThan(0);
  });

  it('allows reserved example hosts and documentation addresses', () => {
    const text = 'GET https://shop.example.test/cart from 192.0.2.10 and http://localhost:3000';
    expect(findLeaks({ text })).toEqual([]);
  });

  it('reports the field path of each finding', () => {
    expect(findLeaks({ evidence: { logExcerpt: 'mail a@b.co' } })).toEqual([
      '$.evidence.logExcerpt: email address',
    ]);
  });
});

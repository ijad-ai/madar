import { z } from 'zod';

/** The five triage classes. See rubric.md for definitions and tie-breaks. */
export const TRIAGE_CLASSES = [
  'product-bug',
  'flaky-test',
  'locator-drift',
  'test-data',
  'environment',
] as const;
export type TriageClass = (typeof TRIAGE_CLASSES)[number];

const triageClass = z.enum(TRIAGE_CLASSES);
const pseudonym = z.string().regex(/^L\d{1,3}$/, 'use a pseudonym such as L1, never a name');

const label = z.object({
  labeler: pseudonym,
  class: triageClass,
  confidence: z.enum(['low', 'medium', 'high']),
  rationale: z.string().min(10).max(1000),
});

export const triageRecordSchema = z
  .object({
    id: z.string().regex(/^tri-\d{4}$/, 'ids look like tri-0001'),
    /** True only for files in fixtures/. Real labeled failures are never synthetic. */
    synthetic: z.boolean(),
    source: z.object({
      ciSystem: z.enum([
        'github-actions',
        'gitlab-ci',
        'jenkins',
        'azure-devops',
        'circleci',
        'other',
      ]),
      repoAlias: z.string().regex(/^repo-[a-z0-9-]{1,40}$/, 'an alias such as repo-checkout-web'),
      runRef: z
        .string()
        .regex(/^run-[0-9a-f]{12}$/, 'a salted hash of the run id, not the id itself'),
      failedOn: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'year and month only, such as 2026-09'),
    }),
    test: z.object({
      framework: z.literal('playwright'),
      fileAlias: z.string().min(1).max(200),
      title: z.string().min(1).max(300),
      browser: z.enum(['chromium', 'firefox', 'webkit', 'other']).optional(),
    }),
    evidence: z.object({
      errorMessage: z.string().min(1).max(2000),
      logExcerpt: z.string().max(8000),
      retry: z.enum(['passed-on-retry', 'failed-on-retry', 'not-retried']),
      hasTrace: z.boolean(),
      hasScreenshot: z.boolean(),
      artifacts: z.array(z.string().regex(/^artifacts\/[A-Za-z0-9._/-]+$/)).default([]),
    }),
    labels: z.array(label).length(2, 'exactly two independent labels'),
    adjudication: z
      .object({
        class: triageClass,
        by: pseudonym,
        note: z.string().min(10).max(1000),
      })
      .optional(),
    finalClass: triageClass,
    anonymization: z.object({
      procedureVersion: z.literal(1),
      reviewedBy: pseudonym,
      reviewedOn: z.iso.date(),
    }),
  })
  .superRefine((record, ctx) => {
    const [first, second] = record.labels;
    if (first === undefined || second === undefined) return;

    if (first.labeler === second.labeler) {
      ctx.addIssue({
        code: 'custom',
        path: ['labels'],
        message: 'the two labels need different labelers',
      });
    }

    if (first.class === second.class) {
      if (record.finalClass !== first.class) {
        ctx.addIssue({
          code: 'custom',
          path: ['finalClass'],
          message: 'labels agree, so finalClass must match them',
        });
      }
      return;
    }

    if (record.adjudication === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['adjudication'],
        message: 'labels disagree, so an adjudication is required',
      });
      return;
    }
    if ([first.labeler, second.labeler].includes(record.adjudication.by)) {
      ctx.addIssue({
        code: 'custom',
        path: ['adjudication', 'by'],
        message: 'the adjudicator must be a third person',
      });
    }
    if (record.finalClass !== record.adjudication.class) {
      ctx.addIssue({
        code: 'custom',
        path: ['finalClass'],
        message: 'finalClass must match the adjudication',
      });
    }
  });

export type TriageRecord = z.infer<typeof triageRecordSchema>;

/**
 * A second line of defence after human anonymization review: patterns that should never
 * survive into a committed record. Returns one message per finding, with the field path.
 */
const LEAK_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['AWS access key', /\b(AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['bearer credential', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['credentials in URL', /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i],
];

/** Hosts allowed in records: reserved example domains and documentation addresses. */
const ALLOWED_HOST = /(^|\.)(example|test|invalid|localhost)$|^example\.(com|org|net)$|^localhost$/;
const DOC_IPV4 = /^(127\.0\.0\.1|192\.0\.2\.\d{1,3}|198\.51\.100\.\d{1,3}|203\.0\.113\.\d{1,3})$/;

function hostLeaks(text: string): string[] {
  const findings: string[] = [];
  for (const match of text.matchAll(/https?:\/\/([^/\s:"'<>)]+)/gi)) {
    const host = (match[1] ?? '').toLowerCase();
    if (!ALLOWED_HOST.test(host) && !DOC_IPV4.test(host))
      findings.push(`real-looking host "${host}"`);
  }
  for (const match of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
    if (!DOC_IPV4.test(match[0])) findings.push(`IP address outside documentation ranges`);
  }
  return findings;
}

export function findLeaks(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    const findings = LEAK_PATTERNS.filter(([, pattern]) => pattern.test(value)).map(
      ([name]) => `${path}: ${name}`,
    );
    return [...findings, ...hostLeaks(value).map((finding) => `${path}: ${finding}`)];
  }
  if (Array.isArray(value))
    return value.flatMap((item, index) => findLeaks(item, `${path}[${index}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => findLeaks(item, `${path}.${key}`));
  }
  return [];
}

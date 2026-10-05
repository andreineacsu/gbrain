import type { BrainEngine } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { writerLintForPutPage } from '../output/post-write.ts';
import type { WriteRequest } from './model.ts';
import { prepareFactsBackstop } from './effect-facts.ts';

const LINT_MESSAGES: Record<string,string> = { citation:'Paragraph has no citation marker.',
  link:'A link target is unavailable.', 'back-link':'A reverse link is missing.', 'triple-hr':'An ambiguous timeline separator was found.' };

export function remoteLinkHint(row: WriteRequest): Record<string, unknown> {
  return row.authority.remote && !row.authority.autoLinkTrusted ? { auto_links: { skipped: 'remote',
    hint: 'Body wikilinks are saved as text but NOT reconciled into the graph inline. With mention_links: queued, a post-commit `links` effect (listed by get_write_request) adds plain mention edges to existing pages this connection can read; typed and frontmatter edges are not added. A stdio `gbrain serve` sweeps them at startup + on idle; `gbrain serve --http` does not self-sweep — run `gbrain sweep --once` (delegates to a live serve over IPC), use trusted local capture/put_page for inline link extraction, or add_link for edges needed now.' } } : {};
}
export function pageNoopAdvisories(row: WriteRequest): Record<string, unknown> {
  return { ...remoteLinkHint(row), ...(['put_page', 'capture', 'edit_page'].includes(row.operation) ? { facts_backstop: { skipped: 'not_imported' } } : {}) };
}
/** Optional lint reads are outside publication locks; its bounded result is retained in the receipt. */
export async function preparePageAdvisories(engine: BrainEngine, row: WriteRequest, page: ParsedPage,
  prior?: Pick<ParsedPage, 'type' | 'compiled_truth' | 'frontmatter'>) {
  const visible = row.authority.remote ? { ...page, compiled_truth: sanitizeRemoteBody(page.compiled_truth),
    timeline: sanitizeRemoteBody(page.timeline ?? '') } : page;
  const lint = await writerLintForPutPage(engine, row.slug, { sourceId: row.source_id, noLog: true, page: visible });
  const sanitized = lint && 'top_findings' in lint ? { ...lint,
    top_findings: lint.top_findings.map(finding => ({ ...finding, message: LINT_MESSAGES[finding.validator] ?? `${finding.validator} validation finding.` })) } : lint;
  const facts = ['put_page', 'capture', 'edit_page'].includes(row.operation)
    ? await prepareFactsBackstop(engine, row, page, prior).catch(() => ({ skipped: 'backstop_error' })) : undefined;
  return { ...remoteLinkHint(row), ...(sanitized ? { writer_lint: sanitized } : {}), ...(facts ? { facts_backstop: facts } : {}) };
}

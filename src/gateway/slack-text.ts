/**
 * Text handling at the Slack boundary, in both directions.
 *
 * Inbound: Slack message text uses `<@U123>`, `<#C123|name>`, `<url|label>` and escapes
 * `&`, `<` and `>`. We turn it into plain text for the model.
 *
 * Outbound: model output is untrusted. Escaping `&`, `<` and `>` means it can never form
 * a Slack control sequence, so it cannot mention people, ping `@channel` or `@here`, or
 * disguise a link behind a label. Plain URLs still auto-link.
 */

/** Slack's documented limit is 40,000 characters; we stay well under it for readability. */
export const MAX_SLACK_TEXT = 12_000;

export type Command =
  | { readonly kind: 'request'; readonly text: string }
  | { readonly kind: 'stop' }
  | { readonly kind: 'help' }
  | { readonly kind: 'empty' };

/** Remove every mention of the bot, then classify what's left. */
export function parseMention(text: string, botUserId: string): Command {
  const mention = new RegExp(`<@${escapeRegExp(botUserId)}(\\|[^>]*)?>`, 'g');
  const rest = text.replace(mention, ' ').replace(/\s+/g, ' ').trim();
  if (rest === '') return { kind: 'empty' };
  if (/^(stop|cancel)[.!]?$/i.test(rest)) return { kind: 'stop' };
  if (/^help[.!?]?$/i.test(rest)) return { kind: 'help' };
  return { kind: 'request', text: rest };
}

/** Make untrusted text safe to post: no mentions, broadcasts or labelled links. */
export function escapeForSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Cut text to a Slack-friendly length, at a line or word boundary where possible. */
export function truncateForSlack(text: string, max = MAX_SLACK_TEXT): string {
  if (text.length <= max) return text;
  const note = `\n\n_(Answer cut at ${max.toLocaleString('en-US')} characters.)_`;
  const budget = max - note.length;
  const slice = text.slice(0, budget);
  const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
  return `${cut > budget * 0.8 ? slice.slice(0, cut) : slice}${note}`;
}

export interface NameResolver {
  user(userId: string): string;
}

/** Convert Slack message markup to plain text the model can read. */
export function slackToPlainText(text: string, names: NameResolver): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => {
      return `@${label ?? names.user(id)}`;
    })
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => {
      return `#${label !== undefined && label !== '' ? label : id}`;
    })
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, label?: string) => label ?? '@group')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

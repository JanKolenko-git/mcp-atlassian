// The issue tools: read, search, transition, create and edit, and the gated delete.
import * as z from 'zod';
import { reply, type Tool } from '../shared/registry.ts';
import { pageFooter, quoted } from '../shared/text.ts';
import { asWiki, browseUrl, epicLinkField, format, issueLine, jira, type Json, key, parseKey, start, WIKI } from './common.ts';
import { FIELDS, formatIssue } from './format.ts';

/** The JQL a search runs: plain text is wrapped as a text search, then scoped and ordered. */
export function searchJql(input: { jql?: string | undefined; text?: string | undefined; project?: string | undefined }): string {
  if ((input.jql === undefined) === (input.text === undefined)) throw new Error('Pass exactly one of `jql` or `text`.');
  // Only the caller's own JQL can already carry a project clause or an ORDER BY; a wrapped text search never does.
  const given = (input.jql ?? '').toLowerCase();
  let jql = input.jql ?? `text ~ ${quoted(input.text ?? '')}`;
  if (input.project && !given.includes('project')) jql = `project = "${input.project}" AND (${jql})`;
  if (!given.includes('order by')) jql += ' ORDER BY updated DESC';
  return jql;
}

interface Transition {
  id: string;
  name: string;
  to?: { name?: string };
}

const destination = (transition: Transition) => transition.to?.name ?? '?';
const describeTransitions = (transitions: Transition[]) =>
  transitions.map((t) => `  ${t.id}\t${t.name}\t->\t${destination(t)}`).join('\n') ||
  '  (none — the workflow offers no transitions from the current status)';

/**
 * The transition to run: destination status first, then the transition's own name, then a unique
 * substring of the destination. A name is checked against what the workflow offers, so it cannot
 * invent a transition; no match returns the available list instead of moving somewhere adjacent.
 */
export function resolveTransition(transitions: Transition[], wanted: string): Transition {
  if (/^\d+$/.test(wanted)) {
    const byId = transitions.find((t) => t.id === wanted);
    if (byId) return byId;
    throw new Error(`no transition with id ${wanted}. Available:\n${describeTransitions(transitions)}`);
  }
  const target = wanted.trim().toLowerCase();
  const exact =
    transitions.find((t) => (t.to?.name ?? '').toLowerCase() === target) ?? transitions.find((t) => t.name.toLowerCase() === target);
  if (exact) return exact;
  const partial = transitions.filter((t) => (t.to?.name ?? '').toLowerCase().includes(target));
  if (partial.length === 1 && partial[0]) return partial[0];
  if (partial.length > 1) {
    throw new Error(`'${wanted}' matches more than one destination:\n${describeTransitions(partial)}\nPass the exact status name or the transition id.`);
  }
  throw new Error(`no transition leads to '${wanted}' from the current status. Available:\n${describeTransitions(transitions)}`);
}

// What the workflow offers depends on the ticket's current status, so it is read every time.
async function transitionsOf(issueKey: string): Promise<Transition[]> {
  const data = (await jira.getJson(`/rest/api/2/issue/${issueKey}/transitions`)) as Json;
  return data.transitions ?? [];
}

const otherFields = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Any other field by id, in the shape Jira takes: {"customfield_10010": "text", "customfield_10020": {"value": "Option"}}. ' +
      'list_fields gives the ids; get_issue_fields gives the required ones and the allowed values.',
  );

// The fields both create and edit take by name.
const named = {
  priority: z.string().optional().describe('Priority name, such as Major'),
  labels: z.array(z.string()).optional().describe('Labels; on edit this replaces every label'),
  components: z.array(z.string()).optional().describe('Component names; on edit this replaces them all'),
  fix_versions: z.array(z.string()).optional().describe('Fix version names; on edit this replaces them all'),
  reporter: z.string().optional().describe('Username of the reporter'),
  due: z.string().optional().describe('Due date, YYYY-MM-DD'),
  epic: z.string().optional().describe('Epic key to file the issue under'),
  fields: otherFields,
};

const createSchema = z.strictObject({
  project: z.string().describe('Project key, such as PROJ'),
  type: z.string().describe('Issue type name, such as Bug, Story or Task'),
  summary: z.string().describe('The title'),
  description: z.string().optional().describe(`The body, ${WIKI}`),
  format,
  assignee: z.string().optional().describe('Username to assign to'),
  parent: z.string().optional().describe('Parent key, when creating a subtask'),
  ...named,
});
type CreateInput = z.infer<typeof createSchema>;

interface FieldInput {
  summary?: string | undefined;
  description?: string | undefined;
  format?: 'wiki' | 'markdown' | undefined;
  priority?: string | undefined;
  labels?: string[] | undefined;
  components?: string[] | undefined;
  fix_versions?: string[] | undefined;
  assignee?: string | null | undefined;
  reporter?: string | undefined;
  due?: string | undefined;
  epic?: string | undefined;
  fields?: Record<string, unknown> | undefined;
}

/** The `fields` object of a create or edit: names resolved to Jira's shapes, the passthrough underneath. */
async function buildFields(input: FieldInput): Promise<Json> {
  const fields: Json = { ...(input.fields ?? {}) };
  if (input.summary !== undefined) fields.summary = input.summary;
  if (input.description !== undefined) fields.description = asWiki(input.description, input.format);
  if (input.priority !== undefined) fields.priority = { name: input.priority };
  if (input.labels !== undefined) fields.labels = input.labels;
  if (input.components !== undefined) fields.components = input.components.map((name) => ({ name }));
  if (input.fix_versions !== undefined) fields.fixVersions = input.fix_versions.map((name) => ({ name }));
  if (input.assignee !== undefined) fields.assignee = input.assignee === null ? null : { name: input.assignee };
  if (input.reporter !== undefined) fields.reporter = { name: input.reporter };
  if (input.due !== undefined) fields.duedate = input.due;
  if (input.epic !== undefined) {
    // Epic Link is a custom field on Data Center; an instance without it files epics as parents.
    const epic = parseKey(input.epic);
    const field = await epicLinkField();
    if (field) fields[field] = epic;
    else fields.parent = { key: epic };
  }
  return fields;
}

async function createFields(input: CreateInput): Promise<Json> {
  const fields = await buildFields(input);
  fields.project = { key: input.project.toUpperCase() };
  fields.issuetype = { name: input.type };
  if (input.parent) fields.parent = { key: parseKey(input.parent) };
  return fields;
}

export function registerIssues(tool: Tool) {
  tool(
    'read',
    'get_issue',
    {
      description:
        'Read a ticket as Markdown: metadata, linked issues with their link ids, attachments with their URLs and ids, ' +
        'the description and comments. Description and comments stay in Jira wiki markup.',
      inputSchema: z.strictObject({
        key,
        comments: z.number().int().min(0).optional().describe('Keep only the N most recent comments; 0 leaves comments out. Default: all'),
        fields: z.array(z.string()).optional().describe('Fields beyond the usual ones, by id, shown under "Other fields"; ["*all"] shows every field with a value'),
        changelog: z.boolean().optional().describe('Append the change history'),
        raw: z.boolean().optional().describe('Return the raw REST JSON instead'),
      }),
    },
    async ({ key: target, comments, fields, changelog, raw }) => {
      const issueKey = parseKey(target);
      const expand = [...(changelog ? ['changelog'] : []), ...(fields?.length ? ['names'] : [])];
      const issue = (await jira.getJson(`/rest/api/2/issue/${issueKey}`, {
        fields: fields?.includes('*all') ? '*all' : [FIELDS, ...(fields ?? [])].join(','),
        expand: expand.length ? expand.join(',') : undefined,
      })) as Json;
      return reply(raw ? JSON.stringify(issue, null, 2) : formatIssue(issueKey, issue, { comments, extra: fields, changelog }));
    },
  );

  tool(
    'read',
    'search_issues',
    {
      description:
        'Search tickets by JQL or by plain text, exactly one of the two. One line per issue: KEY  [Status]  summary  —  URL, ' +
        'then a footer with the total and the `start` for the next page.',
      inputSchema: z.strictObject({
        jql: z.string().optional().describe('A JQL query, sent as written; ORDER BY updated DESC is added when it has no ORDER BY'),
        text: z.string().optional().describe('Plain text to find, searched as text ~ "..."'),
        project: z.string().optional().describe('Restrict to a project key, such as PROJ, unless the JQL already names a project'),
        fields: z.array(z.string()).optional().describe('Fields to show under each line, by id, such as ["assignee", "priority", "customfield_10010"]'),
        limit: z.number().int().min(1).max(100).optional().describe('Most issues to return. Default 20'),
        start,
      }),
    },
    async ({ jql, text: needle, project, fields, limit, start: from = 0 }) => {
      const query = searchJql({ jql, text: needle, project });
      const data = (await jira.getJson('/rest/api/2/search', {
        jql: query,
        startAt: from,
        maxResults: limit ?? 20,
        fields: ['summary', 'status', ...(fields ?? [])].join(','),
      })) as Json;
      const issues: Json[] = data.issues ?? [];
      if (!issues.length) return reply(`No issues matched${from ? ` from start=${from}` : ''}. (JQL: ${query})`);
      return reply([...issues.map((issue) => issueLine(issue, fields)), pageFooter(from, issues.length, Number(data.total ?? issues.length))].join('\n'));
    },
  );

  tool(
    'read',
    'list_transitions',
    {
      description: 'List the workflow transitions a ticket offers from its current status, one per line: id, name, -> destination status.',
      inputSchema: z.strictObject({ key }),
    },
    async ({ key: target }) => {
      const issueKey = parseKey(target);
      const transitions = await transitionsOf(issueKey);
      if (!transitions.length) return reply(`${issueKey}: no transitions available from its current status.`);
      return reply(transitions.map((t) => `${t.id}\t${t.name}\t->\t${destination(t)}`).join('\n'));
    },
  );

  tool(
    'write',
    'transition_issue',
    {
      description:
        'Move a ticket to a status its workflow offers from where it is now, with a resolution, a comment or other fields the transition ' +
        'screen asks for. Reads the available transitions first; an unknown status returns the list instead of guessing.',
      inputSchema: z.strictObject({
        key,
        to: z.string().describe('Destination status name, or a transition id from list_transitions'),
        resolution: z.string().optional().describe('Resolution name to set with the move, such as Fixed or Won\'t Do'),
        comment: z.string().optional().describe(`A comment posted with the move, ${WIKI}`),
        format,
        fields: otherFields,
      }),
    },
    async (input) => {
      const issueKey = parseKey(input.key);
      const chosen = resolveTransition(await transitionsOf(issueKey), input.to);
      const payload: Json = { transition: { id: chosen.id } };
      const fields: Json = { ...(input.fields ?? {}), ...(input.resolution !== undefined && { resolution: { name: input.resolution } }) };
      if (Object.keys(fields).length) payload.fields = fields;
      if (input.comment) payload.update = { comment: [{ add: { body: asWiki(input.comment, input.format) } }] };
      await jira.sendJson(`/rest/api/2/issue/${issueKey}/transitions`, payload, 'POST');
      return reply(`${issueKey} -> ${destination(chosen)}  (via "${chosen.name}", id ${chosen.id})`);
    },
  );

  tool(
    'write',
    'create_issue',
    {
      description:
        "Create a ticket; returns its key and link. Projects differ in which fields their create screen requires: get_issue_fields lists them, and a 400 returns Jira's own message naming the field. " +
        'Unless the project has a template, lay the description out under h3. headings: Problem, Cause, Evidence, Impact, Proposed fix, Open questions, dropping empty ones.',
      inputSchema: createSchema,
    },
    async (input) => {
      const result = (await jira.sendJson('/rest/api/2/issue', { fields: await createFields(input) }, 'POST')) as Json | null;
      if (!result?.key) return reply('Issue created, but Jira returned no key in the response.');
      return reply(`Created ${result.key} — ${browseUrl(result.key)}`);
    },
  );

  tool(
    'write',
    'create_issues',
    {
      description: 'Create up to 50 tickets in one call, each shaped like create_issue. Returns the key of each one created and Jira\'s message for each one refused.',
      inputSchema: z.strictObject({ issues: z.array(createSchema).min(1).max(50).describe('The tickets to create, in order') }),
    },
    async ({ issues }) => {
      const issueUpdates = [];
      for (const issue of issues) issueUpdates.push({ fields: await createFields(issue) });
      const result = (await jira.sendJson('/rest/api/2/issue/bulk', { issueUpdates }, 'POST')) as Json | null;
      const created: Json[] = result?.issues ?? [];
      const failed = new Map<number, string>();
      for (const error of result?.errors ?? []) {
        const messages = [...(error.elementErrors?.errorMessages ?? []), ...Object.entries(error.elementErrors?.errors ?? {}).map(([field, message]) => `${field}: ${message}`)];
        failed.set(error.failedElementNumber, messages.join('; ') || `HTTP ${error.status}`);
      }
      let next = 0;
      const lines = issues.map((issue, index) => {
        if (failed.has(index)) return `✗ ${index + 1}. ${issue.summary} — ${failed.get(index)}`;
        const made = created[next++];
        return made?.key ? `✓ ${made.key} — ${issue.summary} — ${browseUrl(made.key)}` : `? ${index + 1}. ${issue.summary} — no key returned`;
      });
      return reply([`Created ${created.length} of ${issues.length}`, ...lines].join('\n'));
    },
  );

  tool(
    'write',
    'edit_issue',
    {
      description:
        'Change fields on a ticket. `labels`, `components` and `fix_versions` replace the whole list; the `add_*` and `remove_*` forms leave the rest alone. ' +
        'Status is not a field: use transition_issue.',
      inputSchema: z.strictObject({
        key,
        summary: z.string().optional().describe('Replace the title'),
        description: z.string().optional().describe(`Replace the body, ${WIKI}`),
        format,
        assignee: z.string().nullable().optional().describe('Username to assign to; null unassigns'),
        ...named,
        add_labels: z.array(z.string()).optional().describe('Labels to add'),
        remove_labels: z.array(z.string()).optional().describe('Labels to remove'),
        add_components: z.array(z.string()).optional().describe('Component names to add'),
        remove_components: z.array(z.string()).optional().describe('Component names to remove'),
        add_fix_versions: z.array(z.string()).optional().describe('Fix version names to add'),
        remove_fix_versions: z.array(z.string()).optional().describe('Fix version names to remove'),
      }),
    },
    async (input) => {
      const fields = await buildFields(input);
      const update: Json = {};
      const lists = [
        ['labels', input.labels, input.add_labels, input.remove_labels, (label: string) => label],
        ['components', input.components, input.add_components, input.remove_components, (name: string) => ({ name })],
        ['fixVersions', input.fix_versions, input.add_fix_versions, input.remove_fix_versions, (name: string) => ({ name })],
      ] as const;
      for (const [field, replace, add, remove, shape] of lists) {
        const ops = [...(add ?? []).map((v) => ({ add: shape(v) })), ...(remove ?? []).map((v) => ({ remove: shape(v) }))];
        if (!ops.length) continue;
        if (replace !== undefined) throw new Error(`\`${field}\` replaces the whole list, so combining it with an add or remove of ${field} is contradictory. Pick one.`);
        update[field] = ops;
      }
      if (!Object.keys(fields).length && !Object.keys(update).length) throw new Error('Nothing to change: pass at least one field.');

      const issueKey = parseKey(input.key);
      await jira.sendJson(
        `/rest/api/2/issue/${issueKey}`,
        { ...(Object.keys(fields).length && { fields }), ...(Object.keys(update).length && { update }) },
        'PUT',
      );
      const changed = [...new Set([...Object.keys(fields), ...Object.keys(update)])].sort();
      return reply(`Updated ${issueKey}: ${changed.join(', ')} — ${browseUrl(issueKey)}`);
    },
  );

  tool(
    'delete',
    'delete_issue',
    {
      description: 'Delete a ticket for good. There is no trash in Jira: the ticket, its comments, worklogs and attachments are gone. Only on the user naming this exact ticket.',
      inputSchema: z.strictObject({ key, delete_subtasks: z.boolean().optional().describe('Also delete its subtasks; without this, a ticket with subtasks is refused by Jira') }),
    },
    async ({ key: target, delete_subtasks }) => {
      const issueKey = parseKey(target);
      await jira.sendJson(`/rest/api/2/issue/${issueKey}`, undefined, 'DELETE', { deleteSubtasks: delete_subtasks ? 'true' : 'false' });
      return reply(`Deleted ${issueKey}${delete_subtasks ? ' and its subtasks' : ''}.`);
    },
  );
}

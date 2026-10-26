import { readFileSync } from 'node:fs';

import { z } from 'zod';

/**
 * The project map (decision D-003): which Slack channels the bot answers in, per project.
 * It lives in a reviewed file in this repo, so every change goes through a pull request.
 * Later phases add repos, Jira projects, staging hosts and approver groups per project.
 */
const channelId = z
  .string()
  .regex(/^[CG][A-Z0-9]{8,}$/, 'must be a Slack channel id such as C0123ABCD45');

const projectSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'lowercase letters, digits and dashes'),
  name: z.string().min(1).max(100),
  slackChannels: z.array(channelId).min(1, 'list at least one channel'),
});

export const projectMapSchema = z
  .strictObject({
    projects: z.array(projectSchema),
  })
  .superRefine((map, ctx) => {
    const ids = new Set<string>();
    const channelOwner = new Map<string, string>();
    map.projects.forEach((project, index) => {
      if (ids.has(project.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['projects', index, 'id'],
          message: `duplicate project id "${project.id}"`,
        });
      }
      ids.add(project.id);
      for (const channel of project.slackChannels) {
        const owner = channelOwner.get(channel);
        if (owner !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['projects', index, 'slackChannels'],
            message: `channel ${channel} is already mapped to project "${owner}"`,
          });
        }
        channelOwner.set(channel, project.id);
      }
    });
  });

export type Project = z.infer<typeof projectSchema>;

export class ProjectMapError extends Error {
  constructor(source: string, problems: readonly string[]) {
    super(`Invalid project map ${source}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ProjectMapError';
  }
}

export class ProjectMap {
  readonly projects: readonly Project[];
  private readonly byChannel: ReadonlyMap<string, Project>;

  constructor(projects: readonly Project[]) {
    this.projects = projects;
    this.byChannel = new Map(projects.flatMap((p) => p.slackChannels.map((c) => [c, p] as const)));
  }

  /** The project a channel belongs to, or undefined if the bot must not act there. */
  projectForChannel(channel: string): Project | undefined {
    return this.byChannel.get(channel);
  }

  get channelCount(): number {
    return this.byChannel.size;
  }
}

export function parseProjectMap(json: unknown, source = '(inline)'): ProjectMap {
  const result = projectMapSchema.safeParse(json);
  if (!result.success) {
    throw new ProjectMapError(
      source,
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return new ProjectMap(result.data.projects);
}

export function loadProjectMap(path: string): ProjectMap {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProjectMapError(path, [`could not read JSON: ${reason}`]);
  }
  return parseProjectMap(json, path);
}

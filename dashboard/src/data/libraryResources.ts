/**
 * Library family (playbooks, agents, templates) descriptors and mutations.
 */
import { getDefaultResourceStore } from './cache';
import { mutate } from './mutate';
import { apiUrl, playbookWriteTargets, resources, type Resource } from './resources';
import type { PlaybookDetail, PlaybooksResponse } from './types';
import type { TicketTemplateSummaryResponse } from './resources';

export function playbooksList(): Resource<PlaybooksResponse> {
  return resources.playbooks();
}

export function playbookDetail(slug: string): Resource<PlaybookDetail> {
  return resources.playbook(slug);
}

export function templatesList(): Resource<TicketTemplateSummaryResponse> {
  return resources.templates();
}

export function agentsList() {
  return resources.agents();
}

/** One-shot template fetch for create flow (not cached across mounts). */
export async function fetchNewPlaybookTemplate(): Promise<string> {
  const store = getDefaultResourceStore();
  const payload = await store.client.requestJson<{ content: string }>(apiUrl(['playbooks', 'template', 'new']));
  return payload.content;
}

/** One-shot edit payload (body text only). */
export async function fetchPlaybookEditContent(slug: string): Promise<string> {
  const store = getDefaultResourceStore();
  const payload = await store.client.requestJson<{ content: string }>(apiUrl(['playbooks', slug, 'edit']));
  return payload.content;
}

export async function createPlaybook(content: string): Promise<{ slug: string }> {
  return mutate('POST', apiUrl(['playbooks']), { content }, { invalidates: playbookWriteTargets });
}

export async function savePlaybookContent(slug: string, content: string): Promise<void> {
  await mutate('PUT', apiUrl(['playbooks', slug]), { content }, { invalidates: playbookWriteTargets });
}

export async function renamePlaybook(slug: string, newSlug: string): Promise<void> {
  await mutate('PATCH', apiUrl(['playbooks', slug]), { newSlug }, { invalidates: playbookWriteTargets });
}

export async function deletePlaybook(slug: string): Promise<void> {
  await mutate('DELETE', apiUrl(['playbooks', slug]), undefined, { invalidates: playbookWriteTargets });
}

export async function setPlaybookEnabled(slug: string, enabled: boolean): Promise<void> {
  const action = enabled ? 'enable' : 'disable';
  await mutate('POST', apiUrl(['playbooks', slug, action]), undefined, { invalidates: playbookWriteTargets });
}

export { playbookWriteTargets };

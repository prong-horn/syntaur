import type { SavedView } from '@shared/saved-views-schema';
import {
  useSavedViews,
  createSavedView,
  updateSavedView,
  deleteSavedView,
} from './useSavedViews';
import {
  buildCreateViewPayload,
  mergeUpdatedConfig,
  type CreateViewBuilderState,
} from '../lib/savedViews';

/**
 * Shared edit / duplicate / delete mutations for saved views, used by both the
 * `/views` list and the `/views/:id` detail page. Each helper throws on failure
 * so the caller can surface its own toast / keep its dialog open; dialog state and
 * navigation stay in the pages. Create-new is route-workspace specific and stays
 * on the list page.
 */
export function useSavedViewActions() {
  const { views } = useSavedViews();

  // Edit preserves the VIEW's own workspace and merges the built fields onto the
  // FRESHEST config (the live list), so visibility + forward-compat keys survive
  // and a concurrent change isn't clobbered. Re-throws so an open dialog can show
  // the error inline.
  async function submitEdit(target: SavedView, name: string, state: CreateViewBuilderState): Promise<void> {
    const current = views.find((v) => v.id === target.id) ?? target;
    const built = buildCreateViewPayload(state, current.workspace).config;
    const config = mergeUpdatedConfig(current.config, built, current.config);
    await updateSavedView(target.id, { name, config });
  }

  async function duplicate(view: SavedView): Promise<void> {
    await createSavedView({
      name: `${view.name} (copy)`,
      workspace: view.workspace,
      config: view.config,
    });
  }

  async function remove(view: SavedView): Promise<void> {
    await deleteSavedView(view.id);
  }

  return { submitEdit, duplicate, remove };
}

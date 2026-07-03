// Matches ModuleComponentProps in modulab-core/frontend/src/pages/ModulePage.tsx
export interface ModuleComponentProps {
  moduleName: string;
  apiBase: string;
  token: string;
  // initialQuery: the /modules/unifi-network?<query> query string, parsed.
  // Used to deep-link a notification's actionPath straight to the pending-
  // devices view (?view=pending) instead of always opening the overview.
  initialQuery?: URLSearchParams;
}

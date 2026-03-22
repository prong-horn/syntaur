export interface TrackedSession {
  name: string;
  registered: string;
  lastRefreshed: string;
  scannedAt: string;
  alive: boolean;
  windows: TrackedWindow[];
}

export interface TrackedWindow {
  index: number;
  name: string;
  panes: TrackedPane[];
}

export interface TrackedPane {
  index: number;
  command: string;
  cwd: string;
  branch: string | null;
  worktree: boolean;
  ports: number[];
  urls: string[];
  assignment: {
    mission: string;
    slug: string;
    title: string;
  } | null;
}

export interface ServersResponse {
  sessions: TrackedSession[];
  tmuxAvailable: boolean;
}

export interface OverviewServerStats {
  trackedSessions: number;
  aliveSessions: number;
  deadSessions: number;
  totalPorts: number;
}

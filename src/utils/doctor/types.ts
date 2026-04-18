import type { SyntaurConfig } from '../config.js';
import type Database from 'better-sqlite3';

export type CheckStatus = 'pass' | 'warn' | 'error' | 'skipped';

export type RemediationKind = 'manual' | 'auto-safe' | 'auto-destructive';

export interface Remediation {
  kind: RemediationKind;
  suggestion: string;
  command: string | null;
}

export interface CheckResult {
  id: string;
  category: string;
  title: string;
  status: CheckStatus;
  detail?: string;
  affected?: string[];
  remediation?: Remediation;
  autoFixable: boolean;
}

export interface CheckContext {
  config: SyntaurConfig;
  syntaurRoot: string;
  db: Database.Database | null;
  dbError: string | null;
  cwd: string;
  now: Date;
}

export interface Check {
  id: string;
  category: string;
  title: string;
  run(ctx: CheckContext): Promise<CheckResult | CheckResult[]>;
}

export interface DoctorReport {
  version: '1.0';
  syntaurVersion: string;
  ranAt: string;
  summary: {
    pass: number;
    warn: number;
    error: number;
    skipped: number;
  };
  checks: CheckResult[];
}

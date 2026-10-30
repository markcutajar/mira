// What the hub says about updating Mira (decision 60), shared with the page, so it imports nothing.

export interface UpdateStatus {
  /** Up to date, new commits it can take, new commits it leaves alone, or no way to tell. */
  state: 'current' | 'available' | 'blocked' | 'unknown';
  /** The commit the hub runs, short. */
  running?: string;
  /** Where updates come from, such as origin/main. */
  upstream?: string;
  /** How many commits the copy is behind it, and the newest of them. */
  behind?: number;
  changes?: Array<{ hash: string; subject: string }>;
  /** The update changes Mira's packages, so it installs them again and ends the terminals. */
  packages?: boolean;
  /** Why it can't update by itself, or couldn't check. */
  reason?: string;
  checkedAt?: string;
  /** An update is under way: the hub is about to close for it. */
  updating?: boolean;
  /** How the last update went. */
  last?: UpdateOutcome;
}

export interface UpdateOutcome {
  at: string;
  ok: boolean;
  from: string;
  to: string;
  error?: string;
}

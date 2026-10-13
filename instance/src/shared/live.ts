/**
 * Live updates (issue #18): what the instance's WebSockets carry and what
 * `GET /api/activity` answers. Pure types, shared with the web app
 * (`$shared/live` there).
 */

export type PullAction = "opened" | "updated" | "merged" | "closed" | "reopened" | "commented";
export type RepoAction = "created" | "updated" | "deleted";

/** Something that happened in one repo, as `publish(env, repo, event)` takes it. */
export type LiveEvent =
  | {
      type: "push";
      /** Full ref name, e.g. "refs/heads/main". */
      ref: string;
      before: string | null;
      after: string | null;
      /** Commits in the push. */
      count: number;
      pusher?: string | null;
    }
  | { type: "pull"; number: number; action: PullAction; title?: string }
  | {
      type: "run";
      number: number;
      workflow: string;
      /** A RunStatus: queued, running, success, failure, error, cancelled. */
      status: string;
      /** Set when one step changed: its index and status. */
      step?: { idx: number; status: string };
    }
  | { type: "repo"; action: RepoAction };

export type LiveEventType = LiveEvent["type"];

/** An event as a socket receives it. */
export type LiveMessage = LiveEvent & {
  repo: string;
  /** ISO time the instance published it. */
  at: string;
  /** True for a private repo's events: only the owner's sockets get them. */
  private: boolean;
};

/** The first message on every socket. */
export type LiveHello = { type: "hello"; scope: string; owner: boolean };

/** One line of the instance's activity (GET /api/activity), newest first. */
export type ActivityItem =
  | {
      kind: "push";
      repo: string;
      at: string;
      ref: string;
      before: string | null;
      after: string | null;
      count: number;
    }
  | {
      kind: "pull";
      repo: string;
      at: string;
      number: number;
      title: string;
      action: "opened" | "merged" | "closed" | "commented";
    }
  | {
      kind: "run";
      repo: string;
      at: string;
      number: number;
      workflow: string;
      status: string;
      event: string;
      ref: string;
    };

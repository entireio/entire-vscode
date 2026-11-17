import type { TrailDetail, TrailTimeline } from './schemas';
import type { ChangeRef, TimelineOf } from './trails';

/** The first page of a change's timeline, with how it was asked for. */
export interface RememberedTimeline {
  /** A later page is asked for the same way. */
  of: TimelineOf;
  page: TrailTimeline;
}

export interface RememberedTrail {
  detail: TrailDetail;
  /** First pages of the timelines read so far, by change. */
  timelines: Map<string, RememberedTimeline>;
}

function changeKey(change: ChangeRef): string {
  return `${change.repository}/${change.number}`;
}

/**
 * The trails read in one window, most recently used last.
 *
 * Each CLI call for a trail takes seconds, so a trail opened a second time is
 * drawn from here at once. The panel still reads it again and redraws what
 * has changed: what is kept here is a head start and not a source of truth.
 */
export class TrailMemory {
  private readonly trails = new Map<number, RememberedTrail>();

  constructor(private readonly capacity = 40) {}

  get size(): number {
    return this.trails.size;
  }

  /** What is kept about a trail. Asking counts as a use, so the trail is kept longer. */
  get(trail: number): RememberedTrail | undefined {
    const found = this.trails.get(trail);
    if (found) {
      this.trails.delete(trail);
      this.trails.set(trail, found);
    }
    return found;
  }

  /** The trail's ID on Entire, when a read has reported it. */
  idOf(trail: number): string | undefined {
    return this.trails.get(trail)?.detail.id;
  }

  /** Keeps a trail as just read. Its timelines stay for the changes it still has. */
  keepDetail(detail: TrailDetail): void {
    const before = this.trails.get(detail.number);
    const timelines = new Map<string, RememberedTimeline>();
    for (const change of detail.changes) {
      const kept = before?.timelines.get(changeKey(change));
      if (kept) timelines.set(changeKey(change), kept);
    }
    this.trails.delete(detail.number);
    this.trails.set(detail.number, { detail, timelines });
    while (this.trails.size > this.capacity) {
      const oldest = this.trails.keys().next();
      if (oldest.done) break;
      this.trails.delete(oldest.value);
    }
  }

  /** Keeps the first page of a change's timeline. Ignored for a trail that is not kept. */
  keepTimeline(trail: number, change: ChangeRef, timeline: RememberedTimeline): void {
    this.trails.get(trail)?.timelines.set(changeKey(change), timeline);
  }

  timeline(trail: number, change: ChangeRef): RememberedTimeline | undefined {
    return this.trails.get(trail)?.timelines.get(changeKey(change));
  }

  forget(trail: number): void {
    this.trails.delete(trail);
  }

  clear(): void {
    this.trails.clear();
  }
}

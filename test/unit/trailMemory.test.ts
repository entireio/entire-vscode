import { describe, expect, it } from 'vitest';
import type { TrailChange, TrailDetail, TrailTimeline } from '../../src/core/schemas';
import { TrailMemory, type RememberedTimeline } from '../../src/core/trailMemory';

function change(repository: string, number: number): TrailChange {
  return { repository, number, hasCodeChanges: true };
}

function detail(number: number, changes: TrailChange[] = [change('widget', number + 1000)]): TrailDetail {
  return { number, title: `Trail ${number}`, assignees: [], changes };
}

function timeline(title: string): RememberedTimeline {
  const page: TrailTimeline = { events: [{ kind: 'commit', title, agents: [] }], incomplete: false };
  return { of: { trail: { number: 1 } }, page };
}

describe('TrailMemory', () => {
  it('keeps a trail and the first page of the timeline of each of its changes', () => {
    const memory = new TrailMemory();
    const trail = detail(7, [change('widget', 1), change('docs', 1)]);
    memory.keepDetail(trail);
    memory.keepTimeline(7, change('widget', 1), timeline('in widget'));
    memory.keepTimeline(7, change('docs', 1), timeline('in docs'));

    expect(memory.get(7)?.detail).toBe(trail);
    // Changes are numbered inside their repository, so the repository is part of the key.
    expect(memory.timeline(7, { repository: 'widget', number: 1 })?.page.events[0]?.title).toBe('in widget');
    expect(memory.timeline(7, { repository: 'docs', number: 1 })?.page.events[0]?.title).toBe('in docs');
    expect(memory.timeline(7, { repository: 'widget', number: 2 })).toBeUndefined();
  });

  it('knows nothing about a trail it was not given', () => {
    const memory = new TrailMemory();
    expect(memory.get(7)).toBeUndefined();
    expect(memory.idOf(7)).toBeUndefined();
    expect(memory.timeline(7, change('widget', 1))).toBeUndefined();
    // A timeline has nowhere to go until its trail is kept.
    memory.keepTimeline(7, change('widget', 1), timeline('early'));
    expect(memory.size).toBe(0);
    expect(memory.timeline(7, change('widget', 1))).toBeUndefined();
  });

  it('reports the ID of a trail that was read with one', () => {
    const memory = new TrailMemory();
    memory.keepDetail({ ...detail(7), id: '01JT0000000000000000000042' });
    memory.keepDetail(detail(8));
    expect(memory.idOf(7)).toBe('01JT0000000000000000000042');
    expect(memory.idOf(8)).toBeUndefined();
  });

  it('keeps a timeline across a fresh read of its trail, for as long as the trail has the change', () => {
    const memory = new TrailMemory();
    memory.keepDetail(detail(7, [change('widget', 1), change('widget', 2)]));
    memory.keepTimeline(7, change('widget', 1), timeline('first'));
    memory.keepTimeline(7, change('widget', 2), timeline('second'));

    memory.keepDetail(detail(7, [change('widget', 2), change('widget', 3)]));
    expect(memory.timeline(7, change('widget', 1))).toBeUndefined();
    expect(memory.timeline(7, change('widget', 2))?.page.events[0]?.title).toBe('second');
    expect(memory.timeline(7, change('widget', 3))).toBeUndefined();
  });

  it('drops the trail used longest ago once it is full', () => {
    const memory = new TrailMemory(3);
    for (const number of [1, 2, 3]) memory.keepDetail(detail(number));
    // Asking for a trail is a use. Reading its ID is not.
    memory.get(1);
    memory.idOf(2);
    memory.keepDetail(detail(4));
    expect(memory.size).toBe(3);
    expect([1, 2, 3, 4].filter((number) => memory.get(number) !== undefined)).toEqual([1, 3, 4]);
  });

  it('counts a fresh read of a trail as a use', () => {
    const memory = new TrailMemory(2);
    memory.keepDetail(detail(1));
    memory.keepDetail(detail(2));
    memory.keepDetail(detail(1));
    memory.keepDetail(detail(3));
    expect(memory.get(1)).toBeDefined();
    expect(memory.get(2)).toBeUndefined();
  });

  it('forgets one trail, or all of them', () => {
    const memory = new TrailMemory();
    memory.keepDetail(detail(1));
    memory.keepDetail(detail(2));
    memory.keepTimeline(1, change('widget', 1001), timeline('gone'));
    memory.forget(1);
    expect(memory.get(1)).toBeUndefined();
    expect(memory.timeline(1, change('widget', 1001))).toBeUndefined();
    expect(memory.get(2)).toBeDefined();
    memory.clear();
    expect(memory.size).toBe(0);
  });
});

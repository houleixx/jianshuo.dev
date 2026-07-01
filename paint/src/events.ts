export type HubListener = (event: string, data: unknown) => void;

export class EventHub {
  private subs = new Map<string, Set<HubListener>>();

  subscribe(id: string, fn: HubListener): () => void {
    let set = this.subs.get(id);
    if (!set) {
      set = new Set();
      this.subs.set(id, set);
    }
    set.add(fn);
    return () => {
      const s = this.subs.get(id);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subs.delete(id);
    };
  }

  publish(id: string, event: string, data: unknown): void {
    const set = this.subs.get(id);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(event, data);
      } catch {
        /* a bad listener must not break others */
      }
    }
  }
}

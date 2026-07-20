export class SnapshotPublicationDeferral<Key> {
  private readonly depths = new Map<Key, number>();

  defer(key: Key): () => boolean {
    this.depths.set(key, (this.depths.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      const remaining = (this.depths.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.depths.set(key, remaining);
        return false;
      }
      this.depths.delete(key);
      return true;
    };
  }

  isDeferred(key: Key): boolean {
    return this.depths.has(key);
  }
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ReviewNote } from '../utils/review';

type Listener = (notes: ReviewNote[]) => void;

const KEY = 'turbine.reviewNotes.v1';

/**
 * Review notes left on diff lines. Kept until sent or cleared, and persisted
 * so a dropped connection or app restart doesn't lose a half-written review.
 */
class ReviewNotesStore {
  private notes: ReviewNote[] = [];
  private listeners = new Set<Listener>();
  private loaded = false;

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse((await AsyncStorage.getItem(KEY)) || '[]');
      if (Array.isArray(parsed)) this.set(parsed.filter((n) => n && typeof n.body === 'string'), false);
    } catch {}
  }

  get(): ReviewNote[] {
    return this.notes;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  add(note: Omit<ReviewNote, 'id' | 'createdAt'>): ReviewNote | null {
    const body = note.body.trim();
    if (!body) return null;
    const created: ReviewNote = {
      ...note,
      body,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
    };
    this.set([...this.notes, created]);
    return created;
  }

  update(id: string, body: string) {
    const trimmed = body.trim();
    if (!trimmed) return this.remove(id);
    this.set(this.notes.map((n) => (n.id === id ? { ...n, body: trimmed } : n)));
  }

  remove(id: string) {
    this.set(this.notes.filter((n) => n.id !== id));
  }

  clear() {
    this.set([]);
  }

  private set(notes: ReviewNote[], persist = true) {
    this.notes = notes;
    this.listeners.forEach((fn) => fn(notes));
    if (persist) AsyncStorage.setItem(KEY, JSON.stringify(notes)).catch(() => {});
  }
}

export const reviewNotes = new ReviewNotesStore();

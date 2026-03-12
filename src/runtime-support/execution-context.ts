export class ExecutionContext {
  private readonly slots = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    if (!initial) {
      return;
    }
    for (const [key, value] of Object.entries(initial)) {
      const slot = key.trim();
      if (!slot) {
        continue;
      }
      this.slots.set(slot, value);
    }
  }

  get(name: string): string {
    const slot = name.trim();
    if (!slot || !this.slots.has(slot)) {
      throw new Error(`slot not found: ${name}`);
    }
    return this.slots.get(slot) ?? "";
  }

  set(name: string, value: string): void {
    const slot = name.trim();
    if (!slot) {
      throw new Error("slot name required");
    }
    this.slots.set(slot, value);
  }

  has(name: string): boolean {
    return this.slots.has(name.trim());
  }

  pick(names: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of names) {
      out[name] = this.get(name);
    }
    return out;
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.slots.entries());
  }
}

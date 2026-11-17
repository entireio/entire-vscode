import { nodeId, type Node } from './nodes';

/**
 * Keeps one object for each row of a tree, however often the tree is drawn.
 *
 * A tree builds its rows from scratch each time the editor asks for them.
 * `TreeView.reveal`, which is the only way to move a view's selection, takes
 * a row object and looks it up among the ones the editor was given. An equal
 * row that is another object is not found there, and editors before the one
 * that looks rows up by ID refuse it as a duplicate. So each row a tree hands
 * out is the object it handed out for that ID before, brought up to date.
 */
export class RowRegistry {
  private readonly rows = new Map<string, Node>();
  /** The row each row was listed under, which `TreeView.reveal` asks for. */
  private readonly parents = new WeakMap<Node, Node | undefined>();
  private roots = '';

  /** Returns the rows to hand out for freshly built ones, and records what they are listed under. */
  adopt(fresh: readonly Node[], parent: Node | undefined): Node[] {
    return fresh.map((row) => {
      const id = nodeId(row);
      const known = this.rows.get(id);
      let kept = row;
      if (known && known !== row && known.kind === row.kind) {
        // The same row as before, with what is now known about it.
        const fields = known as unknown as Record<string, unknown>;
        for (const key of Object.keys(fields)) {
          if (!(key in row)) delete fields[key];
        }
        Object.assign(fields, row);
        kept = known;
      } else {
        this.rows.set(id, row);
      }
      this.parents.set(kept, parent);
      return kept;
    });
  }

  parentOf(row: Node): Node | undefined {
    return this.parents.get(row);
  }

  /** Forgets the rows of repositories that are no longer open. Every row's ID starts with its repository's root. */
  keepOnly(repoRoots: readonly string[]): void {
    const roots = repoRoots.join('\n');
    if (roots === this.roots) return;
    this.roots = roots;
    for (const id of this.rows.keys()) {
      if (!repoRoots.some((root) => id.startsWith(`${root}|`))) this.rows.delete(id);
    }
  }
}

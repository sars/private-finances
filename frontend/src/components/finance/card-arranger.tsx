import type { ReactNode } from 'react';
import {
  Sortable,
  SortableContent,
  SortableItem,
  SortableOverlay,
} from '@/components/ui/sortable';

export type ArrangeItem = { key: string; node: ReactNode };

/**
 * Cards the person can drag into the order they want.
 *
 * Loaded on its own, only once somebody turns arranging on: dragging pulls in a
 * whole pointer-and-keyboard input library, and a screen that is read far more
 * often than it is rearranged should not pay for that on the way in.
 *
 * The whole card is the grip rather than a small handle in its corner. A handle
 * is a target you have to hit, which on a phone means missing it; the card is
 * as large as the thing being moved, which is the size the gesture wants. That
 * costs nothing, because in arranging mode the links inside a card have no job
 * to do.
 *
 * Keyboard and screen-reader support come from the primitive: an item is picked
 * up with space, moved with the arrow keys and dropped with space again, and
 * each move is announced. Reordering a screen is not a thing only a mouse
 * should be able to do.
 */
export default function CardArranger({
  items,
  onReorder,
  className,
}: {
  items: ArrangeItem[];
  /** The keys in their new order, once a drag settles. */
  onReorder: (keys: string[]) => void;
  className?: string;
}) {
  const byKey = new Map(items.map((item) => [item.key, item.node]));
  return (
    <Sortable
      value={items}
      orientation="mixed"
      getItemValue={(item) => item.key}
      onValueChange={(next) => onReorder(next.map((item) => item.key))}
    >
      <SortableContent className={className}>
        {items.map((item) => (
          <SortableItem key={item.key} value={item.key} asHandle>
            {item.node}
          </SortableItem>
        ))}
      </SortableContent>
      <SortableOverlay>
        {({ value }) => byKey.get(String(value)) ?? null}
      </SortableOverlay>
    </Sortable>
  );
}

export interface FeedItem {
  readonly key: string;
  /** Game-event sequence the record belongs to. */
  readonly sequence: number;
  /** Tie-breaker inside one game sequence. */
  readonly order: number;
  readonly kind: "event" | "speech" | "binding" | "selected" | "failed" | "fallback";
  readonly text: string;
  readonly detail?: string;
  readonly meta?: string;
}

interface FeedProps {
  readonly items: ReadonlyArray<FeedItem>;
  readonly empty: string;
  readonly label: string;
}

const byNewest = (left: FeedItem, right: FeedItem): number =>
  right.sequence - left.sequence || right.order - left.order;

/** Chronological record list, newest first so the latest record needs no scrolling. */
export const Feed = ({ items, empty, label }: FeedProps) => {
  if (items.length === 0) return <p className="empty">{empty}</p>;
  return (
    <ol className="feed" aria-label={label}>
      {items.toSorted(byNewest).map((item) => (
        <li key={item.key} className={item.kind}>
          <code>{item.sequence}</code>
          <div>
            <span>{item.text}</span>
            {item.detail === undefined ? null : <p>{item.detail}</p>}
            {item.meta === undefined ? null : <small>{item.meta}</small>}
          </div>
        </li>
      ))}
    </ol>
  );
};

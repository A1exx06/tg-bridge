export interface QueueOpts { maxDepth: number }

export interface Queue<T> {
  push(item: T): T | undefined
  shift(): T | undefined
  // First item matching pred (FIFO among matches); undefined if none. Leaves
  // the rest in order — used to give the owner's Telegram messages priority
  // over agent-to-agent (swarm) traffic without reordering anything else.
  shiftWhere(pred: (item: T) => boolean): T | undefined
  size(): number
}

export function createQueue<T>(opts: QueueOpts): Queue<T> {
  const buf: T[] = []
  return {
    push(item) {
      let dropped: T | undefined
      if (buf.length >= opts.maxDepth) dropped = buf.shift()
      buf.push(item)
      return dropped
    },
    shift: () => buf.shift(),
    shiftWhere(pred) {
      const i = buf.findIndex(pred)
      if (i < 0) return undefined
      return buf.splice(i, 1)[0]
    },
    size: () => buf.length,
  }
}

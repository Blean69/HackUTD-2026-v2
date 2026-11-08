/**
 * The voice service (pipecat 1.15) reports ONE spoken sentence many times: a `bot-output` event with `spoken_status: "new"`, then one more for every
 * word spoken (`in-progress`, with the same `segment_id` and the whole sentence in `text`), then a last one. The captions must show the sentence
 * once, so only the first event of each segment counts. Events without a segment id (older servers) always count.
 */
export interface SegmentLike {
  segment_id?: number | string;
}

export function isNewSegment(seen: Set<number | string>, d: SegmentLike): boolean {
  if (d.segment_id === undefined || d.segment_id === null) return true;
  if (seen.has(d.segment_id)) return false;
  seen.add(d.segment_id);
  return true;
}
